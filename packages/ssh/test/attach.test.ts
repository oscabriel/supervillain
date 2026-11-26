import { describe, expect } from "bun:test";
import { connect } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";

import { Deferred, Effect } from "effect";

import { fingerprintOf, loadHostKey } from "../src/index.ts";
import type { AttachOptions } from "../src/index.ts";
import { effect } from "./effect.ts";
import { nextEvent } from "./events.ts";
import { clientKey, sshExec, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

const dialed =
	(server: { attach: (socket: Socket, options?: AttachOptions) => void }) =>
	(options?: AttachOptions) =>
		Effect.gen(function* () {
			const farEnd = yield* Deferred.make<Socket>();

			const relay = yield* tcpListener((socket) => {
				Deferred.doneUnsafe(farEnd, Effect.succeed(socket));
			});

			const near = connect(relay.port, "127.0.0.1");
			server.attach(near, options);

			return Object.assign(yield* Deferred.await(farEnd), { near });
		});

const watchClose = (socket: Socket) => {
	let closed = false;
	socket.once("close", () => {
		closed = true;
	});

	return () => closed;
};

const whoami = {
	onExec: (session: {
		info: { relayedActor?: string; identity: { actor: string } };
		write: (t: string) => void;
	}) =>
		Effect.sync(() => {
			session.write(session.info.relayedActor ?? session.info.identity.actor);

			return 0;
		}),
};

describe("attach", () => {
	effect(
		"a link attached with its own host key shows that key on it, and the server's elsewhere",
		() =>
			Effect.gen(function* () {
				const keys = yield* tempDir;
				const key = yield* clientKey(keys, "alice");
				const server = yield* testServer(whoami);

				const gmKey = yield* Effect.promise(
					async () => await loadHostKey(path.join(keys, "gm_key"))
				);

				expect(gmKey.fingerprint).not.toBe(server.hostKeyFingerprint);

				const seen: Array<string> = [];

				const sawHost = (shown: Buffer) => {
					seen.push(fingerprintOf(shown));
				};

				const link = yield* dialed(server)({ hostKey: gmKey.pem });

				yield* ssh2Client({ sock: link, key, onHostKey: sawHost });
				yield* ssh2Client({ port: server.port, key, onHostKey: sawHost });

				const plain = yield* dialed(server)();
				yield* ssh2Client({ sock: plain, key, onHostKey: sawHost });

				expect(seen).toEqual([
					gmKey.fingerprint,
					server.hostKeyFingerprint,
					server.hostKeyFingerprint,
				]);
			})
	);

	effect(
		"a socket the server dialed out serves SSH to whoever is on the far end",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					onExec: (session) =>
						Effect.sync(() => {
							session.write(
								`${session.info.identity.actor} ran ${session.command}`
							);

							return 0;
						}),
				});

				const link = yield* dialed(server)();

				const forwarder = yield* tcpListener((socket) => {
					socket.pipe(link);
					link.pipe(socket);
				});

				const result = yield* sshExec(forwarder.port, ["hello"], { key });
				expect(result).toMatchObject({
					stdout: `key:${key.fingerprint} ran hello`,
					exitCode: 0,
				});
			})
	);

	effect("a socket that closed before it was attached takes no place", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");

			const server = yield* testServer({
				...whoami,
				limits: { connections: 1 },
			});

			const relay = yield* tcpListener((socket) => {
				socket.resume();
			});

			const gone = connect(relay.port, "127.0.0.1");
			yield* nextEvent(gone, "connect");
			gone.destroy();
			yield* nextEvent(gone, "close");
			server.attach(gone);
			expect((yield* sshExec(server.port, ["who"], { key })).exitCode).toBe(0);
		})
	);

	effect(
		"a persistent link carrying nobody outlives the session-start timer",
		() =>
			Effect.gen(function* () {
				const relayKey = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					...whoami,
					timeouts: { sessionStartMs: 150 },
				});

				const attach = dialed(server);
				const admit = { admitRelay: () => true };

				const persistent = yield* attach({ ...admit, persistent: true });
				const persistentClosed = watchClose(persistent);
				const linked = yield* ssh2Client({ sock: persistent, key: relayKey });
				const ordinary = yield* attach(admit);
				const ordinaryClosed = watchClose(ordinary);
				yield* ssh2Client({ sock: ordinary, key: relayKey });

				yield* Effect.sleep("500 millis");
				expect(ordinaryClosed()).toBe(true);
				expect(persistentClosed()).toBe(false);
				expect(
					(yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout
				).toBe(PLAYER);
				yield* Effect.sleep("400 millis");
				expect(persistentClosed()).toBe(false);
				expect(
					(yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout
				).toBe(PLAYER);
			})
	);

	effect(
		"a persistent link whose far end stops answering keepalives is cut",
		() =>
			Effect.gen(function* () {
				const relayKey = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					...whoami,
					timeouts: {
						sessionStartMs: 100,
						keepaliveMs: 100,
						keepaliveCount: 2,
					},
				});

				const link = yield* dialed(server)({
					admitRelay: () => true,
					persistent: true,
				});

				const closed = watchClose(link.near);
				yield* ssh2Client({ sock: link, key: relayKey });
				link.pause();
				yield* waitFor("the link to be cut", closed);
				expect(closed()).toBe(true);
			})
	);

	effect(
		"a relay link admits only the key its caller admits, as the relay",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const relayKey = yield* clientKey(dir, "relay");
				const mallory = yield* clientKey(dir, "mallory");
				const server = yield* testServer({ ...whoami, allowGuests: true });
				const attach = dialed(server);
				const asked: Array<string> = [];

				const admitRelay = (fingerprint: string) => {
					asked.push(fingerprint);

					return fingerprint === relayKey.fingerprint;
				};

				const linked = yield* ssh2Client({
					sock: yield* attach({ admitRelay }),
					key: relayKey,
				});

				expect(
					(yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout
				).toBe(PLAYER);
				expect(yield* Effect.flip(ssh2Exec(linked, "who"))).toBeInstanceOf(
					Error
				);
				expect(asked).toEqual([relayKey.fingerprint]);

				const refused = yield* Effect.flip(
					ssh2Client({ sock: yield* attach({ admitRelay }), key: mallory })
				);

				expect(refused).toBeInstanceOf(Error);
				expect(asked).toEqual([relayKey.fingerprint, mallory.fingerprint]);

				const guest = yield* Effect.flip(
					ssh2Client({ sock: yield* attach({ admitRelay }), keyboard: true })
				);

				expect(guest).toBeInstanceOf(Error);
			})
	);
});
