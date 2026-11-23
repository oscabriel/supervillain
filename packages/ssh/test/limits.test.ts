import { describe, expect } from "bun:test";
import { connect } from "node:net";

import { TextRenderable } from "@opentui/core";
import { Clock, Effect, Exit, Fiber, Logger, Result, Scope } from "effect";
import type ssh2 from "ssh2";

import { kexAlgorithm } from "../src/ssh2Internals.ts";
import { effect } from "./effect.ts";
import { nextEvent } from "./events.ts";
import {
	clientKey,
	opensshKex,
	sshExec,
	sshShell,
	waitFor,
} from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec, ssh2Shell } from "./ssh2client.ts";
import { protocolOf } from "./ssh2Internals.ts";
import { tempDir } from "./tempDir.ts";

const slowEcho =
	(pause: `${number} millis`) =>
	(session: { readonly write: (text: string) => void }) =>
		Effect.sleep(pause).pipe(
			Effect.as(0),
			Effect.tap(() =>
				Effect.sync(() => {
					session.write("ok");
				})
			)
		);

const closeOf = (client: InstanceType<typeof ssh2.Client>) =>
	nextEvent(client, "close");

const heldClient = (options: Parameters<typeof ssh2Client>[0]) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		const client = yield* ssh2Client(options).pipe(Scope.provide(scope));

		return { client, close: Scope.close(scope, Exit.void) };
	});

describe("handshake", () => {
	effect(
		"a client that offers only a slow finite-field key exchange is refused at once",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const server = yield* testServer({ onExec: () => Effect.succeed(0) });
				const start = yield* Clock.currentTimeMillis;

				const refused = yield* sshExec(server.port, ["hello"], {
					key,
					flags: ["-o", "KexAlgorithms=diffie-hellman-group18-sha512"],
				});

				expect(refused.exitCode).toBe(255);
				expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
				expect((yield* sshExec(server.port, ["hello"], { key })).exitCode).toBe(
					0
				);
			})
	);

	effect.skipIf(!opensshKex.includes("mlkem768x25519-sha256"))(
		"OpenSSH agrees on the post-quantum hybrid key exchange and warns of nothing",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const server = yield* testServer({ onExec: () => Effect.succeed(0) });

				const only = yield* sshExec(server.port, ["hello"], {
					key,
					flags: ["-o", "KexAlgorithms=mlkem768x25519-sha256"],
				});

				expect(only.exitCode).toBe(0);

				const chosen = yield* sshExec(server.port, ["hello"], {
					key,
					flags: ["-v"],
				});

				expect(chosen.exitCode).toBe(0);
				expect(chosen.stderr).toContain(
					"kex: algorithm: mlkem768x25519-sha256"
				);
				expect(chosen.stderr).not.toContain("post-quantum");
			})
	);

	effect("our own client agrees on the post-quantum hybrid key exchange", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			const server = yield* testServer({ onExec: () => Effect.succeed(7) });

			const client = yield* ssh2Client({
				port: server.port,
				key,
				kex: [kexAlgorithm("mlkem768x25519-sha256")],
			});

			expect((yield* ssh2Exec(client, "hello")).code).toBe(7);
		})
	);

	effect("the server names itself, not the library, and never compresses", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			const server = yield* testServer({ onExec: () => Effect.succeed(0) });

			const version = yield* Effect.callback<string>((resume) => {
				const socket = connect(server.port, "127.0.0.1");
				socket.on("error", () => {
					socket.destroy();
				});
				socket.once("data", (chunk: Buffer) => {
					const [line = ""] = chunk.toString("latin1").split("\r\n");
					resume(Effect.succeed(line));
					socket.destroy();
				});
			});

			expect(version).toBe("SSH-2.0-supervillain");

			const compressed = yield* sshExec(server.port, ["hello"], {
				key,
				flags: ["-C", "-v"],
			});

			expect(compressed.exitCode).toBe(0);
			expect(compressed.stderr).toContain("compression: none");
			expect(compressed.stderr).not.toContain("compression: zlib");
		})
	);

	effect("a client that rekeys again and again is cut", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");

			const server = yield* testServer({
				onExec: (session) =>
					Effect.gen(function* () {
						for (let i = 0; i < 200; i += 1) {
							session.write("x".repeat(4096));
							yield* Effect.sleep("5 millis");
						}

						return 0;
					}),
			});

			const flood = yield* sshExec(server.port, ["x"], {
				key,
				flags: ["-o", "RekeyLimit=1K"],
			});

			expect(flood.exitCode).toBe(255);
			expect((yield* sshExec(server.port, ["x"], { key })).stdout).toHaveLength(
				200 * 4096
			);
		})
	);

	effect(
		"a connection that never authenticates is cut after the login grace",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({ timeouts: { loginMs: 200 } });
				const start = yield* Clock.currentTimeMillis;
				const socket = connect(server.port, "127.0.0.1");
				socket.on("error", () => {
					socket.destroy();
				});
				socket.resume();
				yield* nextEvent(socket, "close").pipe(Effect.timeout("3 seconds"));
				expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
			})
	);
});

describe("connection limits", () => {
	effect("connections are capped per address", () =>
		Effect.gen(function* () {
			const server = yield* testServer({
				allowGuests: true,
				limits: { connectionsPerAddress: 2 },
				onExec: slowEcho("0 millis"),
			});

			const guest = { port: server.port, keyboard: true };
			const first = yield* heldClient(guest);
			yield* heldClient(guest);
			const third = yield* Effect.flip(ssh2Client(guest));
			expect(third).toBeInstanceOf(Error);

			const elsewhere = yield* ssh2Client({
				...guest,
				localAddress: "127.0.0.2",
			});

			expect((yield* ssh2Exec(elsewhere, "x")).stdout).toBe("ok");
			yield* first.close;
			yield* Effect.sleep("100 millis");
			const again = yield* ssh2Client(guest);
			expect((yield* ssh2Exec(again, "x")).stdout).toBe("ok");
		})
	);

	effect("connections are capped in total", () =>
		Effect.gen(function* () {
			const server = yield* testServer({
				allowGuests: true,
				limits: { connections: 2 },
			});

			const guest = { port: server.port, keyboard: true };
			yield* heldClient({ ...guest, localAddress: "127.0.0.1" });
			yield* heldClient({ ...guest, localAddress: "127.0.0.2" });

			const third = yield* Effect.flip(
				ssh2Client({ ...guest, localAddress: "127.0.0.3" })
			);

			expect(third).toBeInstanceOf(Error);
		})
	);

	effect("sessions are capped per address, across its connections", () =>
		Effect.gen(function* () {
			const server = yield* testServer({
				allowGuests: true,
				limits: { sessionsPerAddress: 2 },
				onExec: slowEcho("300 millis"),
			});

			const a = yield* ssh2Client({ port: server.port, keyboard: true });
			const b = yield* ssh2Client({ port: server.port, keyboard: true });

			const runs = yield* Effect.forEach(
				[a, a, b],
				(client) => Effect.result(ssh2Exec(client, "x")),
				{ concurrency: "unbounded" }
			);

			expect(runs.filter(Result.isSuccess)).toHaveLength(2);

			const other = yield* ssh2Client({
				port: server.port,
				keyboard: true,
				localAddress: "127.0.0.2",
			});

			expect((yield* ssh2Exec(other, "x")).stdout).toBe("ok");
		})
	);

	effect(
		"an address that starts sessions faster than its rate is refused; others are not",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					limits: { sessionRate: { burst: 2, perSecond: 0.001 } },
					onExec: slowEcho("0 millis"),
				});

				const client = yield* ssh2Client({ port: server.port, keyboard: true });
				expect((yield* ssh2Exec(client, "x")).stdout).toBe("ok");
				expect((yield* ssh2Exec(client, "x")).stdout).toBe("ok");
				expect(yield* Effect.flip(ssh2Exec(client, "x"))).toBeInstanceOf(Error);

				const elsewhere = yield* ssh2Client({
					port: server.port,
					keyboard: true,
					localAddress: "127.0.0.2",
				});

				expect((yield* ssh2Exec(elsewhere, "x")).stdout).toBe("ok");
			})
	);

	effect(
		"an authenticated connection that opens no session is cut after the start grace",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					timeouts: { sessionStartMs: 200 },
				});

				const client = yield* ssh2Client({ port: server.port, keyboard: true });
				const start = yield* Clock.currentTimeMillis;
				yield* closeOf(client).pipe(Effect.timeout("3 seconds"));
				expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
			})
	);

	effect(
		"idle connections give their places back, so an address isn't locked out for good",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					limits: { connectionsPerAddress: 2 },
					timeouts: { sessionStartMs: 200 },
					onExec: slowEcho("0 millis"),
				});

				const guest = { port: server.port, keyboard: true };
				const idle = [yield* ssh2Client(guest), yield* ssh2Client(guest)];
				expect(yield* Effect.flip(ssh2Client(guest))).toBeInstanceOf(Error);
				yield* Effect.forEach(idle, closeOf, { concurrency: 1 }).pipe(
					Effect.timeout("3 seconds")
				);
				yield* Effect.sleep("100 millis");
				expect((yield* ssh2Exec(yield* ssh2Client(guest), "x")).stdout).toBe(
					"ok"
				);
			})
	);

	effect(
		"a connection keeps its place while a session runs, and is cut once none is left",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					timeouts: { sessionStartMs: 300 },
					onExec: slowEcho("800 millis"),
				});

				const client = yield* ssh2Client({ port: server.port, keyboard: true });
				expect((yield* ssh2Exec(client, "x")).stdout).toBe("ok");
				const ended = yield* Clock.currentTimeMillis;
				yield* closeOf(client).pipe(Effect.timeout("3 seconds"));
				expect((yield* Clock.currentTimeMillis) - ended).toBeLessThan(2000);
			})
	);

	effect(
		"a session the server ended gives its place back, though its client never answers the close",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					limits: { sessionsPerAddress: 1 },
					timeouts: { sessionStartMs: 200 },
					onExec: slowEcho("0 millis"),
				});

				const guest = { port: server.port, keyboard: true };
				const client = yield* ssh2Client(guest);
				let cut = false;
				client.once("close", () => {
					cut = true;
				});

				const protocol = protocolOf(client);
				const unanswered: Array<number> = [];

				protocol.channelClose = (channel) => {
					unanswered.push(channel);
				};

				expect((yield* ssh2Exec(client, "x")).stdout).toBe("ok");
				expect((yield* ssh2Exec(yield* ssh2Client(guest), "y")).stdout).toBe(
					"ok"
				);
				yield* waitFor("the connection with nothing open to be cut", () => cut);
			})
	);

	effect(
		"a channel that never starts is closed alone; the session beside it carries on",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					limits: { sessionsPerConnection: 2 },
					timeouts: { sessionStartMs: 200 },
					onExec: slowEcho("1200 millis"),
				});

				const client = yield* ssh2Client({ port: server.port, key });
				const running = yield* Effect.forkScoped(ssh2Exec(client, "x"));
				yield* Effect.sleep("50 millis");
				const answers: Array<boolean> = [];
				client.subsys("nothing", (refused) => {
					answers.push(refused === undefined);
				});
				yield* Effect.sleep("500 millis");
				const beside = yield* Effect.forkScoped(ssh2Exec(client, "y"));
				expect((yield* Fiber.join(running)).stdout).toBe("ok");
				expect((yield* Fiber.join(beside)).stdout).toBe("ok");
			})
	);

	effect(
		"a session that never asks for a shell or exec loses its connection",
		() =>
			Effect.gen(function* () {
				const server = yield* testServer({
					allowGuests: true,
					timeouts: { sessionStartMs: 200 },
				});

				const client = yield* ssh2Client({ port: server.port, keyboard: true });

				const start = yield* Clock.currentTimeMillis;
				const answers: Array<boolean> = [];

				yield* Effect.callback<boolean>((resume) => {
					client.once("close", () => {
						resume(Effect.succeed(true));
					});
					client.subsys("nothing", (refused) => {
						answers.push(refused === undefined);
					});
				}).pipe(Effect.timeout("3 seconds"));

				expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(2000);
			})
	);
});

describe("dead peers", () => {
	effect(
		"a frozen client is cut by keepalive, and its session ends",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const ended: Array<string> = [];

				const server = yield* testServer({
					timeouts: { keepaliveMs: 200, keepaliveCount: 2 },
					onShell: (session) =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									ended.push("closed");
								})
							);
							session.renderer.root.add(
								new TextRenderable(session.renderer, { content: "READY" })
							);

							return yield* Effect.never;
						}),
				});

				const terminal = yield* sshShell(
					server.port,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the session", () =>
					terminal.output().includes("READY")
				);
				terminal.pause();
				yield* waitFor(
					"the frozen session to end",
					() => ended.length > 0,
					5000
				);
			}),
		10_000
	);

	effect(
		"a client that stops reading is cut once what waits for it passes the bound",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const logged: Array<string> = [];

				const collect = Logger.make(({ message }) => {
					logged.push(String(message));
				});

				const server = yield* testServer({
					onRaw: (session) =>
						Effect.gen(function* () {
							const flood = setInterval(() => {
								session.stream.write(Buffer.alloc(2 ** 20));
							}, 5);

							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									clearInterval(flood);
								})
							);

							return yield* Effect.never;
						}),
				}).pipe(
					Effect.provideService(Logger.CurrentLoggers, new Set([collect]))
				);

				const cuts = () =>
					logged.filter((line) => line.includes("it stopped reading")).length;

				const still = yield* ssh2Client({ port: server.port, key });
				let stillClosed = false;
				still.once("close", () => {
					stillClosed = true;
				});
				yield* ssh2Shell(still, { cols: 80, rows: 24 });
				yield* waitFor(
					"the channel's reader to be cut",
					() => cuts() === 1 && stillClosed
				);
				const sock = connect(server.port, "127.0.0.1");
				const stalled = yield* ssh2Client({ sock, key });

				const protocol = protocolOf(stalled);
				const session = protocol.session.bind(protocol);

				protocol.session = (id, _window, packet) => {
					session(id, 0xff_ff_ff_ff, packet);
				};

				yield* ssh2Shell(stalled, { cols: 80, rows: 24 });
				sock.pause();
				yield* waitFor(
					"the socket's reader to be cut",
					() => cuts() === 2,
					10_000
				);
			}),
		15_000
	);
});

describe("exec and shell without a terminal", () => {
	effect(
		"a shell without a pty is refused with a hint, and no seat opens",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				let shells = 0;

				const server = yield* testServer({
					noPtyMessage: "Needs a terminal: try ssh -t.",
					onShell: () =>
						Effect.sync(() => {
							shells += 1;
						}),
				});

				const result = yield* sshExec(server.port, [], { key, flags: ["-T"] });
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toBe("Needs a terminal: try ssh -t.\n");
				expect(result.stdout).toBe("");
				expect(shells).toBe(0);
			})
	);

	effect(
		"exec output ends lines with CRLF when the client asked for a pty",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					onExec: (session) =>
						Effect.sync(() => {
							session.write("one\ntwo\n");
							session.writeError("oops\n");

							return 0;
						}),
				});

				const client = yield* ssh2Client({ port: server.port, key });
				const plain = yield* ssh2Exec(client, "x");
				expect([plain.stdout, plain.stderr]).toEqual(["one\ntwo\n", "oops\n"]);
				const withPty = yield* ssh2Exec(client, "x", {}, true);
				expect(withPty.stdout + withPty.stderr).toContain("one\r\ntwo\r\n");
				expect(withPty.stdout + withPty.stderr).toContain("oops\r\n");
			})
	);
});
