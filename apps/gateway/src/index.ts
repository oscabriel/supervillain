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
import { connectRoomStore, serveRoomRegistry } from "@supervillain/room-wire";
import { createSessionRenderer, runTable } from "@supervillain/table";
import { openWsDialer } from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";
import { Server, utils } from "ssh2";
import type {
	AuthContext,
	AuthenticationType,
	Connection,
	PseudoTtyInfo,
	WindowChangeInfo,
} from "ssh2";

import { guestUpgradeBox, isGuestActor, mintGuestActor } from "./guest.js";
import { openRoomRegistry } from "./registry.js";
import type { GatewayRoomRegistry } from "./registry.js";
import { attachSshChannel } from "./ssh-session.js";
import type { SshChannelStream, SshSession } from "./ssh-session.js";

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

const authenticate = (ctx: AuthContext): string | undefined => {
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
		return actor;
	}
	if (ctx.method === "keyboard-interactive") {
		// The keyless guest door: no prompts, straight in.
		ctx.accept();
		return mintGuestActor();
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

const serveShell = async (
	session: SshSession,
	stream: SshChannelStream,
	options: {
		readonly roomName: string;
		readonly registry: GatewayRoomRegistry;
		readonly dial: (address: string) => ReturnType<typeof connectRoomStore>;
	}
): Promise<void> => {
	const address = options.registry.resolve(options.roomName);
	if (address === undefined) {
		farewell(stream, `no room named '${options.roomName}' is registered here.`);
		return;
	}
	let store: Awaited<ReturnType<typeof connectRoomStore>>;
	try {
		store = await options.dial(address);
	} catch {
		farewell(stream, "Could not reach that room. Is the GM's table live?");
		return;
	}
	try {
		const info = await store.info();
		const entry = gatewayRegistry.get(info.gameId);
		if (entry === undefined) {
			farewell(stream, `Unknown game '${info.gameId}'.`);
			return;
		}
		const claim = await store.submit({
			actor: session.actor,
			command: { type: "core.claim-seat" },
		});
		if ("rejected" in claim) {
			farewell(stream, claim.message);
			return;
		}
		if (isGuestActor(session.actor)) {
			stream.write(guestUpgradeBox());
			await awaitKeypress(stream);
		}
		await runTable({
			// One seat's renderer, drawn on demand: an ambient render loop here is
			// a cost paid once per seat (ADR-0012, NQ-14).
			createRenderer: createSessionRenderer,
			entry,
			gameId: info.gameId,
			roomLabel: info.label,
			session,
			store,
		});
	} finally {
		await store.close();
		stream.end();
	}
};

const handleConnection = (
	client: Connection,
	registry: GatewayRoomRegistry,
	dial: (address: string) => ReturnType<typeof connectRoomStore>
): void => {
	let actor: string | undefined;
	let roomName = "";
	client
		.on("authentication", (ctx) => {
			roomName = ctx.username;
			actor = authenticate(ctx) ?? actor;
		})
		.on("ready", () => {
			client.on("session", (acceptSession) => {
				const session = acceptSession();
				let size = { columns: 0, rows: 0 };
				let sshSession: SshSession | undefined;
				session.on("pty", (acceptPty, _rejectPty, info: PseudoTtyInfo) => {
					size = { columns: info.cols, rows: info.rows };
					acceptPty?.();
				});
				session.on(
					"window-change",
					(acceptWc, _rejectWc, info: WindowChangeInfo) => {
						sshSession?.resize({ columns: info.cols, rows: info.rows });
						acceptWc?.();
					}
				);
				session.on("shell", (acceptShell) => {
					const stream = acceptShell() as unknown as SshChannelStream;
					if (actor === undefined) {
						farewell(stream, "authentication left no identity.");
						return;
					}
					sshSession = attachSshChannel({
						actor,
						initialSize: size,
						stream,
					});
					const shellSession = sshSession;
					void (async (): Promise<void> => {
						try {
							await serveShell(shellSession, stream, {
								dial,
								registry,
								roomName,
							});
						} catch {
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
		sshHost: options.sshHost,
		sshPort: options.sshPort,
	});
	const registryServer = serveRoomRegistry(listener, registry);
	const hostKey = await loadOrCreateHostKey(options.stateDir);
	const server = new Server({ hostKeys: [hostKey] }, (client) => {
		handleConnection(client, registry, (address) =>
			connectRoomStore(
				openWsDialer({ secretKeyHex: identity.secretKeyHex, url: address })
			)
		);
	});
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
				await registryServer.close();
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
