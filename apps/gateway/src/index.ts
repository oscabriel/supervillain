#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { GatewayRegistry } from "@supervillain/core";
import {
	apply as drawSteelApply,
	init as drawSteelInit,
} from "@supervillain/draw-steel/model";
import { view as drawSteelView } from "@supervillain/draw-steel/view";
import { apply as fakeApply, init as fakeInit } from "@supervillain/fake/model";
import { view as fakeView } from "@supervillain/fake/view";
import {
	actorFromSshEd25519Blob,
	loadOrCreateIdentity,
} from "@supervillain/identity";
import { serveHostPipes } from "@supervillain/room-wire";
import type {
	GatewayPipeEvent,
	HostPipeServer,
	RoomView,
} from "@supervillain/room-wire";
import { createSessionRenderer, runTable } from "@supervillain/table";
import type { TableHold } from "@supervillain/table";
import { runLobby } from "@supervillain/table/lobby";
import type { LobbyNotice, LobbyOutcome } from "@supervillain/table/lobby";
import { startWsListener } from "@supervillain/transport-ws/server";
import { Server, utils } from "ssh2";
import type {
	AuthContext,
	AuthenticationType,
	ClientInfo,
	Connection,
	PseudoTtyInfo,
	WindowChangeInfo,
} from "ssh2";

import { guestIdentity, guestUpgradeBox, keyedIdentity } from "./guest.js";
import type { SessionIdentity } from "./guest.js";
import {
	createConnectionRateLimiter,
	createLobbyDeadlines,
	DEFAULT_LOBBY_LIMITS,
	LOBBY_EXPIRY_MESSAGE,
} from "./hardening.js";
import type { LobbyDeadlines, LobbyExpiry, LobbyLimits } from "./hardening.js";
import { createOfflineMetrics } from "./offline-metrics.js";
import type { OfflineCounts, OfflineMetrics } from "./offline-metrics.js";
import { openRoomRegistry } from "./registry.js";
import type { GatewayRoomRegistry } from "./registry.js";
import {
	createKeyedSessions,
	doorRefusal,
	keyedActorOf,
	REVOKED_SESSION_MESSAGE,
} from "./revocation.js";
import type { KeyedSessions } from "./revocation.js";
import { GATEWAY_ROLE_USAGE, parseGatewayRoleArgs } from "./role.js";
import { holdRoom } from "./room-hold.js";
import { attachSshChannel, sessionForActor } from "./ssh-session.js";
import type { SshChannelStream, SshConnection } from "./ssh-session.js";
import { pipePairingCode, resolveGatewayTls } from "./tls.js";
import type { GatewayTlsOptions } from "./tls.js";

export {
	loadOrMintPipeCertificate,
	pipePairingCode,
	resolveGatewayTls,
} from "./tls.js";
export type {
	GatewayTlsMode,
	GatewayTlsOptions,
	ResolvedGatewayTls,
} from "./tls.js";

export {
	GATEWAY_ROLE_USAGE,
	parseGatewayRoleArgs,
	type GatewayRoleEnvironment,
	type GatewayRoleOptions,
	type GatewayRoleParse,
} from "./role.js";
export {
	OPERATED_GATEWAY_STATE_DIR,
	resolveGatewayStateDir,
} from "./state-dir.js";
export {
	createKeyedSessions,
	doorRefusal,
	keyedActorOf,
	REVOKED_DOOR_MESSAGE,
	REVOKED_SESSION_MESSAGE,
} from "./revocation.js";
export type { KeyedSessions } from "./revocation.js";

const AUTH_METHODS: AuthenticationType[] = [
	"publickey",
	"keyboard-interactive",
];

/** The one port a self-hosted operator forwards. A tunable default, not a
 * protocol constant: 443 belongs to Caddy on the hosted box (#40), so the pipe
 * takes the conventional alternate. */
const DEFAULT_PIPE_PORT = 8443;

const gatewayRegistry: GatewayRegistry = {
	get: (gameId) => {
		if (gameId === "fake") {
			return {
				model: { apply: fakeApply, init: fakeInit },
				view: fakeView,
			} as never;
		}
		return gameId === "draw-steel"
			? ({
					model: { apply: drawSteelApply, init: drawSteelInit },
					view: drawSteelView,
				} as never)
			: undefined;
	},
};

export interface GatewayOptions {
	/** Holds the gateway identity, SSH host key, and registry database. */
	readonly stateDir: string;
	readonly sshPort: number;
	/** Hostname players are told to ssh to — the summon line, not the bind. */
	readonly sshHost: string;
	readonly bindHost?: string;
	/** TCP port for the room-wire pipe. Defaults to 8443 when this process is the
	 * TLS edge — the one port a self-hosted operator forwards — and to an
	 * ephemeral port when TLS is terminated upstream. */
	readonly brokerPort?: number;
	/** The pipe URL Hosts should dial, when it differs from the bind. */
	readonly brokerUrl?: string;
	/** Where the pipe's TLS ends (ADR-0014). Default: `self-signed`, so a gateway
	 * started with no arguments never carries production traffic in the clear. */
	readonly tls?: GatewayTlsOptions;
	/** Connection-lifecycle exhaust. Metadata only (ADR-0012, NQ-11). */
	readonly onEvent?: (event: GatewayPipeEvent) => void;
	/** Lobby hardening: idle/max timeouts and the per-IP connection window. The
	 * lobby is an unauthenticated held session, so these are on from day one
	 * (ADR-0008). Defaults are floors against squatting, not capacity policy. */
	readonly lobbyLimits?: LobbyLimits;
	/** Envelopes one session may fall behind before its view is dropped — the
	 * per-session budget that keeps a slow reader from stalling its Room. */
	readonly sessionBudget?: number;
	/** How long a seated player is held when their Host goes offline. */
	readonly graceWindowMs?: number;
	readonly gracePollMs?: number;
}

export interface RunningGateway {
	/** The gateway's transport URL — what `create --gateway` dials. */
	readonly url: string;
	readonly sshPort: number;
	/** The offline tripwire's running counts (ADR-0012, NQ-15). */
	readonly offline: () => OfflineCounts;
	/** The Host-onboarding pairing code: this gateway's URL, carrying its
	 * certificate fingerprint when trust comes from a pin rather than a CA.
	 * Undefined when the address Hosts reach this box at is not knowable here. */
	readonly pairingCode: string | undefined;
	/** The fingerprint a Host pins, for a gateway with no CA behind it. */
	readonly certificateFingerprint: string | undefined;
	readonly close: () => Promise<void>;
}

const loadOrCreateHostKey = async (folder: string): Promise<string> => {
	const file = path.join(folder, "ssh_host_ed25519_key");
	try {
		return await readFile(file, "utf-8");
	} catch (error) {
		if (
			!(error instanceof Error && "code" in error && error.code === "ENOENT")
		) {
			throw error;
		}
	}
	const generated = utils.generateKeyPairSync("ed25519");
	await writeFile(file, generated.private, { flag: "wx", mode: 0o600 });
	return generated.private;
};

/** Resolves the connection's identity state. A key resolves to an actor at
 * connect — the key *is* the identity, nothing is minted. A keyless visitor
 * resolves to the pre-identity guest state: ADR-0008 mints the `guest:` actor
 * lazily, at first room entry, because the lobby writes to no log. */
const authenticate = (ctx: AuthContext): SessionIdentity | undefined => {
	if (ctx.method === "publickey" && ctx.key.algo === "ssh-ed25519") {
		const actor = actorFromSshEd25519Blob(ctx.key.data);
		if (actor === undefined) {
			ctx.reject(AUTH_METHODS);
			return undefined;
		}
		if (ctx.signature === undefined) {
			// Pre-auth probe: the client asks whether this key would be accepted.
			ctx.accept();
			return undefined;
		}
		const key = utils.parseKey(ctx.key.data);
		if (
			ctx.blob === undefined ||
			key instanceof Error ||
			!key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)
		) {
			ctx.reject(AUTH_METHODS);
			return undefined;
		}
		ctx.accept();
		return keyedIdentity(actor);
	}
	if (ctx.method === "keyboard-interactive") {
		// The keyless guest door: no prompts, straight in, and no actor yet.
		ctx.accept();
		return guestIdentity();
	}
	ctx.reject(AUTH_METHODS);
	return undefined;
};

/** Closes the channel with an explicit exit status. A client that never gets
 * one calls the session a failure (ssh exits 255), so every ordinary goodbye —
 * leaving the lobby, quitting the table — has to say 0 out loud. */
const closeChannel = (stream: SshChannelStream, status: number): void => {
	stream.exit?.(status);
	stream.end();
};

const farewell = (
	stream: SshChannelStream,
	message: string,
	status = 0
): void => {
	stream.write(`${message}\r\n`);
	closeChannel(stream, status);
};

const awaitKeypress = (stream: SshChannelStream): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a single keypress is an event, not a promise-returning API.
	new Promise((resolve) => {
		stream.once("data", () => resolve());
	});

interface RoomEntryContext {
	/** The durable half — it answers whether a name is claimed at all. */
	readonly registry: GatewayRoomRegistry;
	/** The live half — which Host pipe currently carries a name (ADR-0012). */
	readonly pipes: HostPipeServer;
	readonly identity: SessionIdentity;
	/** The offline tripwire's counters (NQ-15). Counts only. */
	readonly metrics: OfflineMetrics;
	/** How long a seat is held when its Host goes offline. */
	readonly graceMs?: number;
	readonly gracePollMs?: number;
}

/** How one attempt at sitting down ended. `notice` is the lobby's business —
 * an unregistered or unreachable name is never a disconnect (ADR-0008).
 * `failed` is the floor: a plain-text one-liner, then the door closes. */
type RoomEntryResult =
	| { readonly kind: "entered" }
	| { readonly kind: "notice"; readonly notice: LobbyNotice }
	| { readonly kind: "failed"; readonly message: string };

const runRoomTable = async (
	connection: SshConnection,
	stream: SshChannelStream,
	store: RoomView,
	context: RoomEntryContext,
	hold: TableHold
): Promise<RoomEntryResult> => {
	const info = await store.info();
	const entry = gatewayRegistry.get(info.gameId);
	if (entry === undefined) {
		return { kind: "failed", message: `Unknown game '${info.gameId}'.` };
	}
	// The minting threshold: one `guest:` actor per SSH session, minted here at
	// first room entry and reused across hops, with the upgrade box on the same
	// edge — before the guest sits down (ADR-0008).
	const assumed = context.identity.assume();
	if (assumed.minted) {
		// The adoption code is bound to this guest actor and lives seven days in
		// the gateway's own store, so it survives a restart (ADR-0005/0013).
		const minted = context.registry.mintAdoptionCode(assumed.actor);
		stream.write(
			guestUpgradeBox("accepted" in minted ? minted.code : undefined)
		);
		await awaitKeypress(stream);
	}
	const claim = await store.submit({
		actor: assumed.actor,
		command: { type: "core.claim-seat" },
	});
	if ("rejected" in claim) {
		return { kind: "failed", message: claim.message };
	}
	await runTable({
		// One seat's renderer, drawn on demand: an ambient render loop here is
		// a cost paid once per seat (ADR-0012, NQ-14).
		createRenderer: createSessionRenderer,
		entry,
		gameId: info.gameId,
		hold,
		roomLabel: info.label,
		session: sessionForActor(connection, assumed.actor),
		store,
	});
	return { kind: "entered" };
};

/** Which inline notice a name that has no live pipe deserves. The two halves of
 * registration answer two different questions (ADR-0012, NQ-4): the durable
 * half says whether anyone owns the name at all, the live half says whether a
 * Host pipe is carrying it right now. That split is exactly ADR-0008's
 * unknown-versus-offline distinction, and neither is ever a disconnect.
 *
 * ADR-0008 accepts knowingly that distinct copy discloses which names exist:
 * rate limiting mitigates it and names were never capability secrets. */
export const noticeForMissingRoom = (
	roomName: string,
	registry: Pick<GatewayRoomRegistry, "isClaimed">
): LobbyNotice =>
	registry.isClaimed(roomName)
		? { kind: "offline-room", roomName }
		: { kind: "unknown-room", roomName };

/** What a seat is told when the fold drops it for falling too far behind. */
export const SEAT_BEHIND_MESSAGE =
	"this terminal fell too far behind to keep up. Reconnect to sit down again.";

/**
 * One attempt at sitting down, and the grace window that follows a Host dying
 * under it (ADR-0012). A drop is not a disconnect: the seat holds with an
 * honest notice while the Host redials, and the loop re-seats the player on the
 * new pipe if it makes it back inside the window. If it does not, the session
 * lands in the lobby's offline chrome — never on a closed door.
 */
const enterRoom = async (
	connection: SshConnection,
	stream: SshChannelStream,
	roomName: string,
	context: RoomEntryContext
): Promise<RoomEntryResult> => {
	let attempt = 0;
	// oxlint-disable-next-line eslint/no-unreachable-loop -- a Host that returns inside the grace window continues this loop onto its new fold.
	for (;;) {
		const live = context.pipes.live(roomName);
		if (attempt === 0 && context.registry.isClaimed(roomName)) {
			// The tripwire's denominator counts attempts at names that exist; a
			// re-seat after a Host returned is the same join, not a new one.
			context.metrics.recordJoinAttempt(live !== undefined);
		}
		attempt += 1;
		if (live === undefined) {
			return {
				kind: "notice",
				notice: noticeForMissingRoom(roomName, context.registry),
			};
		}
		// The unknown-key-joins case (ADR-0005): before anyone claims a seat, let
		// the room learn whether the graph already knows the person behind this
		// key — the same derived query registration uses, and no queue either way.
		// oxlint-disable-next-line eslint/no-await-in-loop -- each attempt sits on a fresh pipe, and the fresh pipe has to be told.
		await live.deliverLinks();
		const store = live.openStore();
		const hold = holdRoom({
			attached: live,
			dropped: store.dropped,
			graceMs: context.graceMs,
			live: () => context.pipes.live(roomName),
			onGraceExpiry: () => context.metrics.recordGraceExpiry(),
			onHostDrop: () => context.metrics.recordHostDrop(),
			pollMs: context.gracePollMs,
		});
		let result: RoomEntryResult;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- one seat at a time: the next attempt only exists because this one ended.
			result = await runRoomTable(connection, stream, store, context, hold);
		} finally {
			hold.stop();
			// oxlint-disable-next-line eslint/no-await-in-loop -- the view is released before the next one opens.
			await store.close();
		}
		if (result.kind !== "entered") {
			return result;
		}
		const end = hold.end();
		if (end === "host-returned") {
			continue;
		}
		if (end === "grace-expired") {
			return { kind: "notice", notice: { kind: "offline-room", roomName } };
		}
		if (end === "dropped") {
			// The fold dropped this seat for falling behind its budget. The lobby's
			// notice vocabulary is ADR-0008's and says nothing about backpressure,
			// so this takes the pinned floor: one honest plain-text line.
			return { kind: "failed", message: SEAT_BEHIND_MESSAGE };
		}
		return result;
	}
};

const LOBBY_FAREWELL = "the gate closes behind you.";

/** What happens after one visit to the lobby: hold it again (with whatever
 * notice the attempted room entry produced), or close the door with a
 * plain-text line. */
type LobbyStep =
	| { readonly kind: "again"; readonly notice: LobbyNotice | undefined }
	| { readonly kind: "done"; readonly message: string };

/** One visit to the lobby plus whatever room entry it asked for. The idle and
 * max deadlines are armed only while the lobby holds the terminal: a player
 * sitting at a table is not squatting, and a long game is not an idle one. */
const lobbyRound = async (
	connection: SshConnection,
	stream: SshChannelStream,
	notice: LobbyNotice | undefined,
	options: {
		readonly context: RoomEntryContext;
		readonly sshHost: string;
		readonly deadlines: LobbyDeadlines;
		readonly expired: () => LobbyExpiry | undefined;
	}
): Promise<LobbyStep> => {
	const touch = (): void => options.deadlines.touch();
	options.deadlines.hold();
	stream.on("data", touch);
	let outcome: LobbyOutcome;
	try {
		outcome = await runLobby({
			connection,
			createRenderer: createSessionRenderer,
			keyed: options.context.identity.keyed,
			notice,
			sshHost: options.sshHost,
		});
	} finally {
		stream.off("data", touch);
		options.deadlines.release();
	}
	const expiry = options.expired();
	if (expiry !== undefined) {
		return { kind: "done", message: LOBBY_EXPIRY_MESSAGE[expiry] };
	}
	if (outcome.kind === "leave") {
		return { kind: "done", message: LOBBY_FAREWELL };
	}
	const result = await enterRoom(
		connection,
		stream,
		outcome.roomName,
		options.context
	);
	if (result.kind === "failed") {
		return { kind: "done", message: result.message };
	}
	return {
		kind: "again",
		notice: result.kind === "notice" ? result.notice : undefined,
	};
};

/** Everything a session needs that is the gateway's rather than the visitor's:
 * both halves of registration, the tripwire's counters, and the grace numbers. */
interface RoomServices {
	readonly registry: GatewayRoomRegistry;
	readonly pipes: HostPipeServer;
	readonly metrics: OfflineMetrics;
	/** The live keyed terminals, so a key retired right now takes the sessions
	 * it is holding with it rather than waiting for the next login. */
	readonly sessions: KeyedSessions;
	readonly graceMs?: number;
	readonly gracePollMs?: number;
}

const serveShell = async (
	connection: SshConnection,
	stream: SshChannelStream,
	options: {
		readonly roomName: string;
		readonly rooms: RoomServices;
		readonly identity: SessionIdentity;
		readonly sshHost: string;
		readonly limits: LobbyLimits;
	}
): Promise<void> => {
	const context: RoomEntryContext = {
		graceMs: options.rooms.graceMs,
		gracePollMs: options.rooms.gracePollMs,
		identity: options.identity,
		metrics: options.rooms.metrics,
		pipes: options.rooms.pipes,
		registry: options.rooms.registry,
	};
	// A name that resolves to a live table goes straight to the table. The lobby
	// is where you land when there is nothing to land in — which is also where
	// bare `ssh <gateway>` lands, since an SSH client with no user sends the
	// local account name and that is indistinguishable from a typed room name.
	const arrival = await enterRoom(
		connection,
		stream,
		options.roomName,
		context
	);
	if (arrival.kind === "entered") {
		closeChannel(stream, 0);
		return;
	}
	if (arrival.kind === "failed") {
		farewell(stream, arrival.message, 1);
		return;
	}
	let expiry: LobbyExpiry | undefined;
	const deadlines = createLobbyDeadlines({
		limits: options.limits,
		onExpire: (reason) => {
			expiry = reason;
			connection.close();
		},
	});
	const round = {
		context,
		deadlines,
		expired: (): LobbyExpiry | undefined => expiry,
		sshHost: options.sshHost,
	};
	let step: LobbyStep = { kind: "again", notice: arrival.notice };
	while (step.kind === "again") {
		// oxlint-disable-next-line eslint/no-await-in-loop -- the lobby is a held session: one visit finishes before the next room entry starts.
		step = await lobbyRound(connection, stream, step.notice, round);
	}
	farewell(stream, step.message);
};

const handleConnection = (
	client: Connection,
	options: {
		readonly rooms: RoomServices;
		readonly sshHost: string;
		readonly limits: LobbyLimits;
	}
): void => {
	let identity: SessionIdentity | undefined;
	let roomName = "";
	client
		.on("authentication", (ctx) => {
			roomName = ctx.username;
			identity = authenticate(ctx) ?? identity;
		})
		.on("ready", () => {
			client.on("session", (acceptSession) => {
				const session = acceptSession();
				let size = { columns: 0, rows: 0 };
				let connection: SshConnection | undefined;
				session.on("pty", (acceptPty, _rejectPty, info: PseudoTtyInfo) => {
					size = { columns: info.cols, rows: info.rows };
					acceptPty?.();
				});
				session.on(
					"window-change",
					(acceptWc, _rejectWc, info: WindowChangeInfo) => {
						connection?.resize({ columns: info.cols, rows: info.rows });
						acceptWc?.();
					}
				);
				session.on("shell", (acceptShell) => {
					const stream = acceptShell() as unknown as SshChannelStream;
					const shellIdentity = identity;
					if (shellIdentity === undefined) {
						farewell(stream, "authentication left no identity.", 1);
						return;
					}
					// The door's half of the revoked-key refusal (ADR-0012, NQ-3). It
					// lands here rather than at the auth callback because rejecting the
					// publickey method would drop the visitor into the keyless guest
					// path — a retired key would become a guest instead of being told
					// anything.
					const refusal = doorRefusal(shellIdentity, options.rooms.registry);
					if (refusal !== undefined) {
						farewell(stream, refusal, 1);
						client.end();
						return;
					}
					const keyed = keyedActorOf(shellIdentity);
					connection = attachSshChannel({ initialSize: size, stream });
					const shellConnection = connection;
					const release =
						keyed === undefined
							? undefined
							: options.rooms.sessions.hold(keyed, () => {
									farewell(stream, REVOKED_SESSION_MESSAGE, 1);
								});
					void (async (): Promise<void> => {
						try {
							await serveShell(shellConnection, stream, {
								identity: shellIdentity,
								limits: options.limits,
								roomName,
								rooms: options.rooms,
								sshHost: options.sshHost,
							});
						} catch {
							// The floor beneath a TUI failure: one plain-text line, then
							// the door closes (ADR-0008).
							farewell(stream, "The table collapsed. Try again.", 1);
						} finally {
							release?.();
							client.end();
						}
					})();
				});
			});
		})
		.on("error", () => {
			// A dropped client ends only its own connection.
		});
};

export const startGateway = async (
	options: GatewayOptions
): Promise<RunningGateway> => {
	const identity = await loadOrCreateIdentity(options.stateDir);
	const tls = await resolveGatewayTls(
		options.stateDir,
		options.tls ?? { mode: "self-signed" }
	);
	// The bind follows the TLS edge: a process that terminates its own TLS is the
	// public edge and must be reachable through the forwarded port, while a
	// process behind a proxy is reached over loopback and should be no wider
	// (#40 holds the web backend to the same line).
	const brokerBind =
		options.bindHost ?? (tls.terminatesHere ? "0.0.0.0" : "127.0.0.1");
	const listener = await startWsListener({
		advertisedUrl: options.brokerUrl,
		host: brokerBind,
		port: options.brokerPort ?? (tls.terminatesHere ? DEFAULT_PIPE_PORT : 0),
		secretKeyHex: identity.secretKeyHex,
		tls: tls.listenerTls,
	});
	const registry = openRoomRegistry({
		path: path.join(options.stateDir, "registry.db"),
	});
	const sessions = createKeyedSessions();
	/** Revocation is immediate on every surface, not just the one it was asked
	 * on: the pipe half closes the retired key's pipes, and this closes the
	 * terminals it is sitting at. */
	const onPipeEvent = (event: GatewayPipeEvent): void => {
		if (event.kind === "key-revoked") {
			sessions.drop(event.key);
		}
		options.onEvent?.(event);
	};
	// The Host dials in; the gateway never dials a Host (ADR-0012). Logging is
	// metadata only — lifecycle and room names, never a payload (NQ-11).
	const pipes = serveHostPipes({
		door: { sshHost: options.sshHost, sshPort: options.sshPort },
		// The key-equivalence graph reaches the broker as an injected interface,
		// never a driver: `room-wire` compiles and tests under Node too (NQ-12).
		keys: registry,
		listener,
		onEvent: onPipeEvent,
		ownership: registry,
		sessionBudget: options.sessionBudget,
	});
	const metrics = createOfflineMetrics();
	const hostKey = await loadOrCreateHostKey(options.stateDir);
	const limits = options.lobbyLimits ?? DEFAULT_LOBBY_LIMITS;
	const rateLimiter = createConnectionRateLimiter({ limits });
	const server = new Server(
		{ hostKeys: [hostKey] },
		(client, info: ClientInfo) => {
			if (!rateLimiter.admit(info.ip)) {
				// Per-IP rate limiting is on from the lobby's first commit: the lobby
				// is an unauthenticated held session (ADR-0008). Refused before the
				// handshake, so there is no channel to say it on.
				client.end();
				return;
			}
			handleConnection(client, {
				limits,
				rooms: {
					graceMs: options.graceWindowMs,
					gracePollMs: options.gracePollMs,
					metrics,
					pipes,
					registry,
					sessions,
				},
				sshHost: options.sshHost,
			});
		}
	);
	// oxlint-disable-next-line promise/avoid-new -- ssh2's listen is callback-shaped.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.sshPort, options.bindHost ?? "0.0.0.0", () => {
			server.off("error", reject);
			resolve();
		});
	});
	let closePromise: Promise<void> | undefined;
	return {
		certificateFingerprint: tls.fingerprint,
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				// oxlint-disable-next-line promise/avoid-new -- ssh2's close is callback-shaped.
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
				await pipes.close();
				await listener.close();
				registry.close();
			})();
			return closePromise;
		},
		offline: () => metrics.counts(),
		pairingCode: pipePairingCode({
			advertisedUrl: options.brokerUrl,
			bindHost: brokerBind,
			boundUrl: listener.url,
			fingerprint: tls.fingerprint,
		}),
		sshPort: options.sshPort,
		url: listener.url,
	};
};

/** Reads `SUPERVILLAIN_GATEWAY_TLS`. Anything unrecognised is a refusal rather
 * than a silent fall back to the default: the difference between the modes is
 * whether production traffic is encrypted by this process, and guessing at it
 * is not a thing an operator can audit. */
const tlsFromEnvironment = (): GatewayTlsOptions => {
	const mode = process.env.SUPERVILLAIN_GATEWAY_TLS ?? "self-signed";
	if (mode === "self-signed" || mode === "terminated-upstream") {
		return { mode };
	}
	if (mode === "files") {
		const certificatePath = process.env.SUPERVILLAIN_GATEWAY_TLS_CERT;
		const privateKeyPath = process.env.SUPERVILLAIN_GATEWAY_TLS_KEY;
		if (certificatePath === undefined || privateKeyPath === undefined) {
			throw new Error(
				"SUPERVILLAIN_GATEWAY_TLS=files needs SUPERVILLAIN_GATEWAY_TLS_CERT and SUPERVILLAIN_GATEWAY_TLS_KEY."
			);
		}
		return { certificatePath, mode, privateKeyPath };
	}
	throw new Error(
		`SUPERVILLAIN_GATEWAY_TLS='${mode}' is not one of self-signed, terminated-upstream, files.`
	);
};

/** What the operator reads on start. A pairing code when this process knows the
 * address Hosts reach it at; otherwise the fingerprint plus the one variable
 * that completes it — never a code naming a wildcard bind. */
export const gatewayBanner = (
	gateway: RunningGateway,
	stateDir?: string
): string => {
	const state = stateDir === undefined ? "" : `  state:    ${stateDir}\n`;
	const door = `the gate is open.\n\n  ssh port: ${gateway.sshPort}\n${state}`;
	if (gateway.pairingCode !== undefined) {
		return `${door}  host pairing code (for supervillain create --gateway):\n\n  ${gateway.pairingCode}\n\n`;
	}
	const fingerprint =
		gateway.certificateFingerprint === undefined
			? ""
			: `  certificate fingerprint: sha256:${gateway.certificateFingerprint}\n`;
	return `${door}  the pipe is listening on ${gateway.url}\n${fingerprint}\n  set SUPERVILLAIN_GATEWAY_BROKER_URL to the address your Hosts reach this\n  box at — your domain or dynamic-DNS name and the forwarded port — and a\n  pairing code is printed here instead.\n\n`;
};

/** Resolves the first time the operator asks the gateway to stop. An
 * always-on box is stopped by a service manager (SIGTERM) at least as often as
 * by a human at a terminal (SIGINT), so both are the same event here. */
const untilShutdown = (): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a process signal is an event, not a promise-returning API.
	new Promise<void>((resolve) => {
		const stop = (): void => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});

/**
 * The gateway **role**, run out of the one compiled binary (ADR-0015). This is
 * what `supervillain gateway serve` reaches, and it is the whole self-hosted
 * posture: the SSH door, the broker Hosts dial out to, the gateway's own store,
 * and — since the default TLS mode is `self-signed` — a certificate it mints
 * for itself, so a clean box needs no CA, no domain, and no proxy. No web
 * surface, no publishing: those are hosted-only at v1 (ADR-0013).
 */
export const serveGateway = async (
	args: readonly string[]
): Promise<number> => {
	const parsed = parseGatewayRoleArgs(args, {
		env: process.env,
		homeDir: homedir(),
	});
	if (parsed.kind === "help") {
		console.log(GATEWAY_ROLE_USAGE);
		return 0;
	}
	if (parsed.kind === "error") {
		console.error(parsed.message);
		console.error(GATEWAY_ROLE_USAGE);
		return 1;
	}
	let tls: GatewayTlsOptions;
	try {
		tls = tlsFromEnvironment();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	// A clean box has no state directory yet; the gateway makes its own rather
	// than demanding a provisioning step (ADR-0015's clean-box criterion).
	await mkdir(parsed.options.stateDir, { mode: 0o700, recursive: true });
	const gateway = await startGateway({ ...parsed.options, tls });
	process.stdout.write(gatewayBanner(gateway, parsed.options.stateDir));
	await untilShutdown();
	await gateway.close();
	return 0;
};

if (import.meta.main) {
	process.exitCode = await serveGateway(process.argv.slice(2));
}
