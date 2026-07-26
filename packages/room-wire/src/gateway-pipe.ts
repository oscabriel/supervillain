/**
 * The gateway's half of the pipe (ADR-0012). It listens; it never dials a Host.
 * Registration splits in two here: the durable half (`name → owner`) belongs to
 * the gateway's store behind {@link RoomOwnership}, and the live half
 * (`name → current pipe`) is memory only — the routing truth, and never durable
 * (ADR-0013's never-durable mirror).
 *
 * Each live name carries one {@link RoomFold}: one upstream feed per Room, and
 * one view per session over it (NQ-5). This file owns the plumbing between the
 * fold and the frames; the fold owns the isolation.
 */
import type {
	Envelope,
	RoomCheckpointProducer,
	RoomCommand,
	RoomSubmission,
} from "@supervillain/core";

import {
	encodePipeHandshakeOutcome,
	negotiatePipeVersion,
	parsePipeHello,
	UNSUPPORTED_VERSION_MESSAGE,
} from "./frames.js";
import {
	ACTOR_ROSTER_REQUEST,
	decodeJson,
	encodeJson,
	encodeSubmitRequest,
	isValidRoomName,
	parseActorRoster,
	parseEnvelope,
	parseLinkRequest,
	parseRegistrationRequest,
	parseRoomInfo,
	parseRoomSubmission,
	ROOM_NAME_RULE,
} from "./messages.js";
import type {
	ActorLink,
	LinkCodeOutcome,
	LinkRedemptionOutcome,
	RegistrationOutcome,
	RevocationOutcome,
	RoomInfo,
	SubmitRequest,
} from "./messages.js";
import { MultiplexPipe, PipeStreamClosedError } from "./pipe.js";
import type { PipeStream } from "./pipe.js";
import { createRoomFold } from "./room-fold.js";
import type {
	RoomFold,
	RoomFoldSource,
	RoomSubmitChannel,
	RoomView,
	RoomViewReservation,
} from "./room-fold.js";
import { TransportListenerClosedError } from "./seam.js";
import type { TransportConnection, TransportListener } from "./seam.js";
import { mintSubmissionId, SubmissionUncertainError } from "./submissions.js";

export type ClaimOutcome =
	| { readonly accepted: true; readonly ownerId: string }
	| { readonly rejected: true; readonly message: string };

/**
 * The durable half. `hostKey` is the pipe's challenge-signature authenticated
 * key; the store resolves it to an owner and answers with that owner's id, so
 * the day a resolved identity replaces a bare key nothing above this seam
 * changes.
 */
export interface RoomOwnership {
	readonly claim: (hostKey: string, name: string) => Promise<ClaimOutcome>;
}

/**
 * ADR-0005's key-equivalence graph, seen from the broker: the questions the
 * pipe asks of it, and nothing else. It is **injected, never imported** — the
 * graph lives in the gateway's `bun:sqlite` store and this package compiles and
 * tests under Node as well (NQ-12), so a driver may never appear here.
 *
 * `resolveActorLinks` is the whole of ADR-0013's derive-never-queue decision:
 * a caller hands over the actors it knows about and gets back the links it is
 * missing. Nothing is recorded about who was told what — no queue, no delivery
 * bookkeeping, no acknowledgement — because the graph is already the complete
 * truth and a queue would be a staler second copy of a computable fact.
 *
 * `isRevoked` is **synchronous on purpose** (ADR-0013): the pipe asks it on the
 * authentication path, and the answer must arrive with no network, no backend
 * process, and our servers unreachable. That is the whole reason revoked state
 * is a column in the gateway's own store rather than a call to a backend.
 */
export interface KeyGraph {
	readonly resolveActorLinks: (
		actors: readonly string[]
	) => Promise<readonly ActorLink[]>;
	readonly mintDeviceCode: (key: string) => Promise<LinkCodeOutcome>;
	readonly redeemLinkCode: (
		code: string,
		key: string
	) => Promise<LinkRedemptionOutcome>;
	/** Whether this key has been retired (ADR-0012, NQ-3). An unknown key is not
	 * revoked — it is merely unknown, and the two are told apart out loud. */
	readonly isRevoked: (key: string) => boolean;
	/** Retires `target` on behalf of the authenticated `byKey`. The graph decides
	 * whether that pairing is allowed; this seam only carries the answer. */
	readonly revokeKey: (
		target: string,
		byKey: string
	) => Promise<RevocationOutcome>;
}

const NO_KEY_GRAPH = "This gateway does not serve key linking.";

/** The stand-in for a gateway built without a graph: it refuses honestly
 * rather than pretending nothing was linked. Nothing is revoked at such a
 * gateway either — there is no graph to hold the state. */
const unservedKeyGraph: KeyGraph = {
	isRevoked: () => false,
	mintDeviceCode: () =>
		Promise.resolve({ message: NO_KEY_GRAPH, rejected: true }),
	redeemLinkCode: () =>
		Promise.resolve({ message: NO_KEY_GRAPH, rejected: true }),
	resolveActorLinks: () => Promise.resolve([]),
	revokeKey: () => Promise.resolve({ message: NO_KEY_GRAPH, rejected: true }),
};

/**
 * What a retired key is told when it dials the pipe. Distinct from every "no
 * such name" and "that name is another identity's" refusal on this channel: a
 * GM who retired a key and then presented it deserves to be told which of the
 * two happened (ADR-0012, NQ-3).
 */
export const REVOKED_HOST_KEY_MESSAGE =
	"This key has been retired and can no longer host. Link this machine again with 'supervillain key link' to host from it.";

/** The live half: which pipe is currently carrying a claimed name. */
export interface LiveRoom {
	readonly name: string;
	readonly ownerId: string;
	/** The Host key on the far end of the live pipe. */
	readonly hostKey: string;
	/** One session's view of the Room's shared fold. Each caller closes its
	 * own; falling behind costs that view alone. */
	readonly openStore: () => RoomView;
	/** Atomically holds one of `capacity` session slots until the caller opens
	 * or releases it. A failed reservation leaves the fold untouched. */
	readonly reserveStore: (capacity: number) => RoomViewReservation | undefined;
	/** Sessions currently viewing this Room. Counts only (NQ-11). */
	readonly views: () => number;
	/**
	 * Re-derives this room's missing linking facts from the graph and stamps
	 * them in. It is the unknown-key-joins case of ADR-0005 — "linked to anyone
	 * in my log?" — answered by the same query registration uses, so a person
	 * who adopted their guest actor last week is recognized before they claim a
	 * seat. Resolves even when nothing could be asked; it never throws.
	 */
	readonly deliverLinks: () => Promise<void>;
}

/** Metadata only (ADR-0012, NQ-11): lifecycle, room names, error codes. */
export type GatewayPipeEvent =
	| { readonly kind: "pipe-closed"; readonly hostKey: string }
	| { readonly kind: "pipe-opened"; readonly hostKey: string }
	| { readonly kind: "pipe-refused"; readonly reason: string }
	| { readonly kind: "room-attached"; readonly room: string }
	| { readonly kind: "room-offline"; readonly room: string }
	| {
			readonly kind: "room-refused";
			readonly room: string;
			readonly reason: string;
	  }
	| { readonly kind: "view-dropped"; readonly room: string }
	| {
			readonly kind: "room-linked";
			readonly room: string;
			readonly links: number;
	  }
	/** A key was retired just now. The gateway's other surfaces listen for this
	 * to drop whatever that key is still holding open. */
	| { readonly kind: "key-revoked"; readonly key: string };

export interface HostPipeServerOptions {
	readonly listener: TransportListener;
	readonly ownership: RoomOwnership;
	/** ADR-0005's graph. Omitted, the link channel refuses and no room is ever
	 * told about linking. */
	readonly keys?: KeyGraph;
	/** What a registered Host is told to put in its summon line. */
	readonly door: { readonly sshHost: string; readonly sshPort: number };
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatMisses?: number;
	/** Envelopes one session may fall behind before its view is dropped. */
	readonly sessionBudget?: number;
	/** The render-fold adapter supplied by the gateway composition root. The
	 * payload stays opaque here; omitting this preserves full Envelope history. */
	readonly checkpoint?: {
		readonly create: (info: RoomInfo) => RoomCheckpointProducer | undefined;
		readonly tail?: number;
	};
	/**
	 * Rooms one identity may have **attached at once** (ADR-0012, NQ-10). A
	 * cost ceiling, not a claim on the name: durable ownership is untouched by
	 * this, so a refused room stays yours and attaches the moment one of your
	 * others detaches. Omitted, nothing is capped.
	 */
	readonly roomsPerIdentity?: number;
	readonly onEvent?: (event: GatewayPipeEvent) => void;
}

export interface HostPipeServer {
	/** The live registration for a name, or undefined when no pipe carries it —
	 * which is exactly what "the room is offline" means. */
	readonly live: (name: string) => LiveRoom | undefined;
	readonly liveNames: () => readonly string[];
	readonly close: () => Promise<void>;
}

const NOT_SERVED =
	"Only the register and link channels are served by the gateway.";

/** What a Host is told when its identity is already carrying as many rooms as
 * this gateway holds at once. It says the number, it says the name is still
 * theirs, and it names the free exit (ADR-0012, NQ-9/NQ-10). */
export const roomsPerIdentityRefusal = (name: string, cap: number): string =>
	`This gateway carries ${cap} rooms at a time per identity, and yours are all attached. '${name}' is still yours — close another room, or run your own gateway.`;

const closeQuietly = async (connection: TransportConnection): Promise<void> => {
	try {
		await connection.close();
	} catch {
		// The peer may already have dropped the connection.
	}
};

/**
 * The Room's one upstream feed, read by the fold and by nobody else. Credit by
 * credit, so the Host is never asked for more than the gateway has taken.
 *
 * @yields {Envelope} every event the Host serves, in Log order.
 */
const streamRoom = async function* streamRoom(
	pipe: MultiplexPipe,
	room: string,
	fromSeq: number
): AsyncGenerator<Envelope> {
	const stream = pipe.open(room, "stream");
	try {
		await stream.send(encodeJson({ fromSeq }));
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- each credit grants exactly one Envelope.
			await stream.send(encodeJson({ next: true }));
			// oxlint-disable-next-line eslint/no-await-in-loop -- envelopes arrive in Log order, one per credit.
			const envelope = parseEnvelope(decodeJson(await stream.receive()));
			yield envelope;
		}
	} catch {
		// A dead pipe ends the feed; the Room is offline, and nothing here
		// re-dials on the fold's behalf.
	} finally {
		stream.close();
	}
};

const write = async (
	stream: PipeStream,
	request: SubmitRequest
): Promise<void> => {
	await stream.send(encodeSubmitRequest(request));
};

/**
 * One session's submit channel. The single resend it allows is the narrow one
 * ADR-0001 always allowed — a write that failed on a stream this channel was
 * reusing, which the peer had already dropped — and it carries the same
 * submission id, so the Host's dedupe answers instead of appending twice. A
 * lost *answer* is never resent: it surfaces as
 * {@link SubmissionUncertainError} for a person to decide about.
 */
const openSubmitChannel = (
	pipe: MultiplexPipe,
	room: string
): RoomSubmitChannel => {
	let current: PipeStream | undefined;
	let closed = false;

	const discard = (dead: PipeStream): void => {
		if (current === dead) {
			current = undefined;
		}
		dead.close();
	};

	const answer = async (stream: PipeStream): Promise<RoomSubmission> => {
		try {
			return parseRoomSubmission(decodeJson(await stream.receive()));
		} catch (error) {
			discard(stream);
			throw new SubmissionUncertainError({ cause: error });
		}
	};

	return {
		close() {
			closed = true;
			if (current !== undefined) {
				discard(current);
			}
		},
		async send(command: RoomCommand, submissionId: string) {
			if (closed) {
				throw new PipeStreamClosedError("Room view is closed.");
			}
			const request: SubmitRequest = { command, submissionId };
			const reused = current !== undefined;
			const stream = (current ??= pipe.open(room, "submit"));
			try {
				await write(stream, request);
			} catch (error) {
				discard(stream);
				if (!reused) {
					throw error;
				}
				const retry = (current = pipe.open(room, "submit"));
				try {
					await write(retry, request);
				} catch (retryError) {
					discard(retry);
					throw retryError;
				}
				return await answer(retry);
			}
			return await answer(stream);
		},
	};
};

const roomSource = (pipe: MultiplexPipe, room: string): RoomFoldSource => ({
	close: () => Promise.resolve(),
	async info() {
		const stream = pipe.open(room, "info");
		try {
			await stream.send(encodeJson({}));
			return parseRoomInfo(decodeJson(await stream.receive()));
		} finally {
			stream.close();
		}
	},
	openSubmit: () => openSubmitChannel(pipe, room),
	stream: (fromSeq) => streamRoom(pipe, room, fromSeq),
});

interface PipeRegistrar {
	readonly attach: (name: string, ownerId: string) => void;
	/** The refusal a concurrency cap produces, or undefined when this room may
	 * attach. Asked after ownership is settled, because the cap counts an
	 * *owner's* live rooms. */
	readonly refuseAttach: (name: string, ownerId: string) => string | undefined;
	/** Asks the freshly attached room for its actor roster and stamps whatever
	 * the graph says it is missing. */
	readonly deliverLinks: (name: string) => void;
	readonly detach: (pipe: MultiplexPipe) => void;
	readonly ownership: RoomOwnership;
	readonly keys: KeyGraph;
	/** Called once a key has actually been retired, so the live half can drop
	 * whatever that key is still holding. */
	readonly onRevoked: (key: string) => void;
	readonly door: { readonly sshHost: string; readonly sshPort: number };
	readonly onEvent: (event: GatewayPipeEvent) => void;
}

/**
 * The gateway's half of `key link`: a CLI holds a pipe with no rooms on it and
 * opens one link stream per command. The connection's authenticated identity
 * *is* the key minting or redeeming — a mint or a redemption never names a key,
 * so nobody can link someone else's.
 *
 * `revoke` is the exception that proves it: retiring a key means naming one you
 * are no longer at, so the request carries a target. The graph checks that
 * target against the connection's own identity, which is why the check cannot
 * live here.
 */
const serveLinkRequest = async (
	stream: PipeStream,
	key: string,
	registrar: Pick<PipeRegistrar, "keys" | "onRevoked">
): Promise<void> => {
	const request = parseLinkRequest(decodeJson(await stream.receive()));
	if ("revoke" in request) {
		const outcome = await registrar.keys.revokeKey(request.revoke, key);
		await stream.send(encodeJson(outcome));
		stream.close();
		if ("accepted" in outcome) {
			registrar.onRevoked(outcome.revoked);
		}
		return;
	}
	const outcome: LinkCodeOutcome | LinkRedemptionOutcome =
		"mint" in request
			? await registrar.keys.mintDeviceCode(key)
			: await registrar.keys.redeemLinkCode(request.redeem, key);
	await stream.send(encodeJson(outcome));
	stream.close();
};

const serveLink = async (
	stream: PipeStream,
	key: string,
	registrar: Pick<PipeRegistrar, "keys" | "onRevoked">
): Promise<void> => {
	try {
		await serveLinkRequest(stream, key, registrar);
	} catch {
		stream.fail("Link request failed.");
	}
};

/**
 * ADR-0013's offline-room case, with no mechanism of its own: the room names
 * its actors, the graph answers, and the answers arrive as gateway-stamped
 * submissions — actor ≠ connection, which is exactly the trusted-stamper power
 * ADR-0003 grants the gateway a Host registered with.
 *
 * Nothing here is retried, acknowledged, or recorded. The Host's own fold makes
 * a repeated fact a no-op, so the next registration re-derives the same answer
 * for free.
 */
const deliverDerivedLinks = async (
	pipe: MultiplexPipe,
	name: string,
	registrar: Pick<PipeRegistrar, "keys" | "onEvent">
): Promise<void> => {
	const stream = pipe.open(name, "link");
	let actors: readonly string[];
	try {
		await stream.send(encodeJson(ACTOR_ROSTER_REQUEST));
		actors = parseActorRoster(decodeJson(await stream.receive()));
	} finally {
		stream.close();
	}
	if (actors.length === 0) {
		return;
	}
	const links = await registrar.keys.resolveActorLinks(actors);
	if (links.length === 0) {
		return;
	}
	// Its own submit channel, not a view of the fold: these are the gateway's own
	// stamped submissions, and they must not spend a session's budget.
	const channel = openSubmitChannel(pipe, name);
	try {
		for (const link of links) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- one submit channel, one linking event at a time.
			await channel.send(
				{
					actor: link.actor,
					command: { linked: link.linked, type: "core.link-actor" },
				},
				mintSubmissionId()
			);
		}
	} finally {
		channel.close();
	}
	registrar.onEvent({ kind: "room-linked", links: links.length, room: name });
};

/** A Host that cannot answer the roster ask, or a graph that cannot be read,
 * costs the room nothing: it stays attached and simply learns nothing today. */
const deliverLinks = async (
	pipe: MultiplexPipe,
	name: string,
	registrar: Pick<PipeRegistrar, "keys" | "onEvent">
): Promise<void> => {
	try {
		await deliverDerivedLinks(pipe, name, registrar);
	} catch {
		// Metadata-only silence: nothing here is durable, so nothing is lost.
	}
};

/** One honest no, in the shape the Host's registration parser expects. */
const refuse = async (stream: PipeStream, message: string): Promise<void> => {
	const outcome: RegistrationOutcome = { message, rejected: true };
	await stream.send(encodeJson(outcome));
	stream.close();
};

const handleRegister = async (
	stream: PipeStream,
	hostKey: string,
	registrar: PipeRegistrar
): Promise<void> => {
	const name = parseRegistrationRequest(decodeJson(await stream.receive()));
	// The revoked-key refusal on the Host pipe (ADR-0012, NQ-3), read locally
	// off the graph before anything is claimed or renewed. It is deliberately
	// *not* the "already claimed by another key" line: the two are different
	// facts and a GM is owed the right one.
	if (registrar.keys.isRevoked(hostKey)) {
		await stream.send(
			encodeJson({
				message: REVOKED_HOST_KEY_MESSAGE,
				rejected: true,
			} as const)
		);
		stream.close();
		registrar.onEvent({
			kind: "pipe-refused",
			reason: REVOKED_HOST_KEY_MESSAGE,
		});
		return;
	}
	if (!isValidRoomName(name)) {
		await refuse(stream, ROOM_NAME_RULE);
		return;
	}
	const claim = await registrar.ownership.claim(hostKey, name);
	if ("rejected" in claim) {
		await refuse(stream, claim.message);
		return;
	}
	// Ownership first, capacity second: the durable claim answers "is this name
	// yours", and the cap answers "will this box carry it right now". A refusal
	// here leaves the claim standing (ADR-0012, NQ-10).
	const capped = registrar.refuseAttach(name, claim.ownerId);
	if (capped !== undefined) {
		await refuse(stream, capped);
		registrar.onEvent({ kind: "room-refused", reason: capped, room: name });
		return;
	}
	const outcome: RegistrationOutcome = {
		accepted: true,
		sshHost: registrar.door.sshHost,
		sshPort: registrar.door.sshPort,
	};
	await stream.send(encodeJson(outcome));
	stream.close();
	registrar.attach(name, claim.ownerId);
	registrar.onEvent({ kind: "room-attached", room: name });
	registrar.deliverLinks(name);
};

/** Registration never throws upward: a malformed request costs that exchange
 * its stream, nothing more. */
const register = async (
	stream: PipeStream,
	hostKey: string,
	registrar: PipeRegistrar
): Promise<void> => {
	try {
		await handleRegister(stream, hostKey, registrar);
	} catch {
		stream.fail("Registration failed.");
	}
};

const acceptPipe = async (
	connection: TransportConnection,
	options: HostPipeServerOptions,
	registrar: Omit<PipeRegistrar, "attach" | "deliverLinks"> & {
		readonly attach: (
			pipe: MultiplexPipe,
			name: string,
			ownerId: string
		) => void;
	}
): Promise<MultiplexPipe | undefined> => {
	const hello = parsePipeHello(await connection.receive());
	const version = negotiatePipeVersion(hello.versions);
	if (version === undefined) {
		await connection.send(
			encodePipeHandshakeOutcome({
				message: UNSUPPORTED_VERSION_MESSAGE,
				rejected: true,
			})
		);
		registrar.onEvent({
			kind: "pipe-refused",
			reason: UNSUPPORTED_VERSION_MESSAGE,
		});
		await connection.close();
		return undefined;
	}
	await connection.send(
		encodePipeHandshakeOutcome({ accepted: true, version })
	);
	const pipe: MultiplexPipe = new MultiplexPipe({
		connection,
		heartbeatIntervalMs: options.heartbeatIntervalMs,
		heartbeatMisses: options.heartbeatMisses,
		initiator: false,
		onClosed: () => {
			registrar.detach(pipe);
			registrar.onEvent({ hostKey: connection.remoteId, kind: "pipe-closed" });
		},
		onStream: (stream) => {
			if (stream.channel === "link") {
				void serveLink(stream, connection.remoteId, registrar);
				return;
			}
			if (stream.channel !== "register") {
				stream.fail(NOT_SERVED);
				return;
			}
			void register(stream, connection.remoteId, {
				...registrar,
				attach: (name, ownerId) => registrar.attach(pipe, name, ownerId),
				deliverLinks: (name) => {
					void deliverLinks(pipe, name, registrar);
				},
			});
		},
	});
	registrar.onEvent({ hostKey: connection.remoteId, kind: "pipe-opened" });
	return pipe;
};

/**
 * Accepts Host pipes until closed. A dropped pipe — dead heartbeat, clean
 * shutdown, or a crashed Host — takes its live registrations with it, so no
 * name ever points at a pipe that is not there.
 */
export const serveHostPipes = (
	options: HostPipeServerOptions
): HostPipeServer => {
	const onEvent = options.onEvent ?? ((): void => undefined);
	const liveRooms = new Map<
		string,
		LiveRoom & { readonly pipe: MultiplexPipe; readonly fold: RoomFold }
	>();
	const pipes = new Set<MultiplexPipe>();
	let closing = false;

	const drop = (name: string, room: { readonly fold: RoomFold }): void => {
		liveRooms.delete(name);
		void room.fold.close();
	};

	const detach = (pipe: MultiplexPipe): void => {
		pipes.delete(pipe);
		const detached = [...liveRooms].filter(([, room]) => room.pipe === pipe);
		for (const [name, room] of detached) {
			drop(name, room);
			onEvent({ kind: "room-offline", room: name });
		}
	};

	const keys = options.keys ?? unservedKeyGraph;

	const attach = (pipe: MultiplexPipe, name: string, ownerId: string): void => {
		// The same identity always supersedes its own live registration: a
		// crash-restart or a machine move re-points the name, it does not queue.
		const previous = liveRooms.get(name);
		if (previous !== undefined) {
			drop(name, previous);
		}
		const fold = createRoomFold({
			checkpoint: options.checkpoint,
			onEvent: (event) => {
				if (event.kind === "view-dropped") {
					onEvent({ kind: "view-dropped", room: name });
				}
			},
			sessionBudget: options.sessionBudget,
			source: roomSource(pipe, name),
		});
		liveRooms.set(name, {
			deliverLinks: () => deliverLinks(pipe, name, { keys, onEvent }),
			fold,
			hostKey: pipe.remoteId,
			name,
			openStore: () => fold.openView(),
			ownerId,
			pipe,
			reserveStore: (capacity) => fold.reserveView(capacity),
			views: () => fold.views(),
		});
	};

	/**
	 * Revocation takes effect **immediately**, not at next authentication
	 * (ADR-0012's "the gateway must refuse them", read honestly): the pipe a
	 * retired key is holding right now is closed, and its rooms go offline with
	 * it. The alternative — letting a live pipe run until it happens to redial —
	 * would leave a compromised always-on box hosting for as long as it stayed
	 * connected, which is the exact event NQ-3 graduated revocation for.
	 *
	 * The redial that follows is refused at registration, so the box stops for
	 * good rather than looping.
	 */
	const onRevoked = (key: string): void => {
		const retired = [...pipes].filter((pipe) => pipe.remoteId === key);
		for (const pipe of retired) {
			void pipe.close();
		}
		onEvent({ key, kind: "key-revoked" });
	};

	/** The concurrency cap, counted over live registrations. Re-registering a
	 * name you already carry is never refused: it supersedes, so it costs the
	 * identity nothing new. */
	const refuseAttach = (name: string, ownerId: string): string | undefined => {
		const cap = options.roomsPerIdentity;
		if (cap === undefined) {
			return undefined;
		}
		let attached = 0;
		for (const [liveName, room] of liveRooms) {
			if (room.ownerId === ownerId && liveName !== name) {
				attached += 1;
			}
		}
		return attached < cap ? undefined : roomsPerIdentityRefusal(name, cap);
	};

	const registrar = {
		attach,
		detach,
		door: options.door,
		keys,
		onEvent,
		onRevoked,
		ownership: options.ownership,
		refuseAttach,
	};

	const admit = async (connection: TransportConnection): Promise<void> => {
		let pipe: MultiplexPipe | undefined;
		try {
			pipe = await acceptPipe(connection, options, registrar);
		} catch {
			await closeQuietly(connection);
			return;
		}
		if (pipe === undefined) {
			return;
		}
		if (closing) {
			await pipe.close();
			return;
		}
		pipes.add(pipe);
	};

	const acceptLoop = (async (): Promise<void> => {
		for (;;) {
			let connection: TransportConnection;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- accepting pipe after pipe is the loop's purpose.
				connection = await options.listener.accept();
			} catch (error) {
				if (!(closing || error instanceof TransportListenerClosedError)) {
					onEvent({ kind: "pipe-refused", reason: "accept failed" });
				}
				return;
			}
			void admit(connection);
		}
	})();

	let closePromise: Promise<void> | undefined;
	return {
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				closing = true;
				await options.listener.close();
				await acceptLoop;
				await Promise.all([...pipes].map((pipe) => pipe.close()));
				pipes.clear();
				await Promise.all(
					[...liveRooms.values()].map((room) => room.fold.close())
				);
				liveRooms.clear();
			})();
			return closePromise;
		},
		live: (name: string) => liveRooms.get(name),
		liveNames: () => [...liveRooms.keys()],
	};
};
