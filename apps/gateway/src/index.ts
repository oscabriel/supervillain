#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
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
	PipeRoomStore,
} from "@supervillain/room-wire";
import { createSessionRenderer, runTable } from "@supervillain/table";
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
import { openRoomRegistry } from "./registry.js";
import type { GatewayRoomRegistry } from "./registry.js";
import { attachSshChannel, sessionForActor } from "./ssh-session.js";
import type { SshChannelStream, SshConnection } from "./ssh-session.js";

const AUTH_METHODS: AuthenticationType[] = [
	"publickey",
	"keyboard-interactive",
];

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
	/** TCP port for the room-wire pipe; 0 takes an ephemeral port. Default: 0. */
	readonly brokerPort?: number;
	/** The pipe URL Hosts should dial, when it differs from the bind. */
	readonly brokerUrl?: string;
	/** Connection-lifecycle exhaust. Metadata only (ADR-0012, NQ-11). */
	readonly onEvent?: (event: GatewayPipeEvent) => void;
	/** Lobby hardening: idle/max timeouts and the per-IP connection window. The
	 * lobby is an unauthenticated held session, so these are on from day one
	 * (ADR-0008). Defaults are floors against squatting, not capacity policy. */
	readonly lobbyLimits?: LobbyLimits;
}

export interface RunningGateway {
	/** The gateway's transport URL — what `create --gateway` dials. */
	readonly url: string;
	readonly sshPort: number;
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

const farewell = (stream: SshChannelStream, message: string): void => {
	stream.write(`${message}\r\n`);
	stream.end();
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
	store: PipeRoomStore,
	identity: SessionIdentity
): Promise<RoomEntryResult> => {
	const info = await store.info();
	const entry = gatewayRegistry.get(info.gameId);
	if (entry === undefined) {
		return { kind: "failed", message: `Unknown game '${info.gameId}'.` };
	}
	// The minting threshold: one `guest:` actor per SSH session, minted here at
	// first room entry and reused across hops, with the upgrade box on the same
	// edge — before the guest sits down (ADR-0008).
	const assumed = identity.assume();
	if (assumed.minted) {
		stream.write(guestUpgradeBox());
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
		roomLabel: info.label,
		session: sessionForActor(connection, assumed.actor),
		store,
	});
	return { kind: "entered" };
};

const enterRoom = async (
	connection: SshConnection,
	stream: SshChannelStream,
	roomName: string,
	context: RoomEntryContext
): Promise<RoomEntryResult> => {
	// The two halves of registration answer two different questions (ADR-0012,
	// NQ-4): the durable half says whether anyone owns the name at all, the live
	// half says whether a Host pipe is carrying it right now. That split is
	// exactly ADR-0008's unknown-versus-offline distinction.
	const live = context.pipes.live(roomName);
	if (live === undefined) {
		return {
			kind: "notice",
			notice: context.registry.isClaimed(roomName)
				? { kind: "offline-room", roomName }
				: { kind: "unknown-room", roomName },
		};
	}
	const store = live.openStore();
	try {
		return await runRoomTable(connection, stream, store, context.identity);
	} finally {
		await store.close();
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

const serveShell = async (
	connection: SshConnection,
	stream: SshChannelStream,
	options: {
		readonly roomName: string;
		readonly registry: GatewayRoomRegistry;
		readonly pipes: HostPipeServer;
		readonly identity: SessionIdentity;
		readonly sshHost: string;
		readonly limits: LobbyLimits;
	}
): Promise<void> => {
	const context: RoomEntryContext = {
		identity: options.identity,
		pipes: options.pipes,
		registry: options.registry,
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
		stream.end();
		return;
	}
	if (arrival.kind === "failed") {
		farewell(stream, arrival.message);
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
		readonly registry: GatewayRoomRegistry;
		readonly pipes: HostPipeServer;
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
						farewell(stream, "authentication left no identity.");
						return;
					}
					connection = attachSshChannel({ initialSize: size, stream });
					const shellConnection = connection;
					void (async (): Promise<void> => {
						try {
							await serveShell(shellConnection, stream, {
								identity: shellIdentity,
								limits: options.limits,
								pipes: options.pipes,
								registry: options.registry,
								roomName,
								sshHost: options.sshHost,
							});
						} catch {
							// The floor beneath a TUI failure: one plain-text line, then
							// the door closes (ADR-0008).
							farewell(stream, "The table collapsed. Try again.");
						} finally {
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
	const listener = await startWsListener({
		advertisedUrl: options.brokerUrl,
		host: options.bindHost,
		port: options.brokerPort,
		secretKeyHex: identity.secretKeyHex,
	});
	const registry = openRoomRegistry({
		path: path.join(options.stateDir, "registry.db"),
	});
	// The Host dials in; the gateway never dials a Host (ADR-0012). Logging is
	// metadata only — lifecycle and room names, never a payload (NQ-11).
	const pipes = serveHostPipes({
		door: { sshHost: options.sshHost, sshPort: options.sshPort },
		listener,
		onEvent: options.onEvent,
		ownership: registry,
	});
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
				pipes,
				registry,
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
		sshPort: options.sshPort,
		url: listener.url,
	};
};

const main = async (): Promise<void> => {
	const stateRoot =
		process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
	const brokerPort = process.env.SUPERVILLAIN_GATEWAY_BROKER_PORT;
	const gateway = await startGateway({
		bindHost: process.env.SUPERVILLAIN_GATEWAY_BIND,
		brokerPort: brokerPort === undefined ? undefined : Number(brokerPort),
		brokerUrl: process.env.SUPERVILLAIN_GATEWAY_BROKER_URL,
		sshHost: process.env.SUPERVILLAIN_GATEWAY_SSH_HOST ?? "127.0.0.1",
		sshPort: Number(process.env.SUPERVILLAIN_GATEWAY_SSH_PORT ?? 2222),
		stateDir:
			process.env.SUPERVILLAIN_GATEWAY_STATE ??
			path.join(stateRoot, "supervillain-gateway"),
	});
	process.stdout.write(
		`the gate is open.\n\n  ssh port: ${gateway.sshPort}\n  gateway address (for supervillain create --gateway):\n\n  ${gateway.url}\n\n`
	);
	process.once("SIGINT", () => {
		void (async (): Promise<void> => {
			await gateway.close();
			process.exit(0);
		})();
	});
};

if (import.meta.main) {
	await main();
}
