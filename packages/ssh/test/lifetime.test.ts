import { describe, expect } from "bun:test";

import { TextRenderable } from "@opentui/core";
import { Effect, Exit, Logger, Scope } from "effect";

import type { ShellSession } from "../src/index.ts";
import { effect, must } from "./effect.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Shell } from "./ssh2client.ts";
import { protocolOf } from "./ssh2Internals.ts";
import { tempDir } from "./tempDir.ts";

const recorder = (after: Effect.Effect<void> = Effect.never) => {
	const log: Array<string> = [];
	const sessions: Array<ShellSession> = [];

	const onShell = (session: ShellSession) =>
		Effect.gen(function* () {
			sessions.push(session);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					log.push("closed");
				})
			);
			session.renderer.root.add(
				new TextRenderable(session.renderer, { content: "READY" })
			);
			yield* after;
		});

	return { log, sessions, onShell };
};

describe("session lifetime", () => {
	effect(
		"a client that drops closes the session scope and destroys the renderer",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const { log, sessions, onShell } = recorder();
				const server = yield* testServer({ onShell });

				const terminal = yield* sshShell(
					server.port,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the session", () =>
					terminal.output().includes("READY")
				);
				expect(log).toEqual([]);
				terminal.kill();
				yield* waitFor("the finalizer", () => log.length > 0);
				expect(log).toEqual(["closed"]);
				yield* waitFor(
					"the renderer to go",
					() => must(sessions[0], "onShell ran").renderer.isDestroyed
				);
			})
	);

	effect(
		"closing the server's scope ends live sessions and their clients",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const { log, onShell } = recorder();
				const scope = yield* Scope.make();

				const server = yield* testServer({
					onShell,
					shutdownNotice: "The GM closed the table.",
				}).pipe(Scope.provide(scope));

				const terminal = yield* sshShell(
					server.port,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the session", () =>
					terminal.output().includes("READY")
				);
				yield* Scope.close(scope, Exit.void);
				expect(log).toEqual(["closed"]);

				const exited = yield* Effect.promise(
					async () => await terminal.exited
				).pipe(Effect.timeout("3 seconds"));

				expect(exited).toBeNumber();
				const output = terminal.output();
				expect(
					output.lastIndexOf("The GM closed the table.\r\n")
				).toBeGreaterThan(output.lastIndexOf("\u001B[?1049l"));
				const refused = yield* sshExec(server.port, ["hello"], { key });
				expect(refused.exitCode).toBe(255);
			})
	);

	effect(
		"a session accepted before the server began to close can't start once it has",
		() =>
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				let seats = 0;

				const server = yield* testServer({
					allowGuests: true,
					onShell: () =>
						Effect.gen(function* () {
							seats += 1;
							yield* Effect.addFinalizer(() => Effect.sleep("600 millis"));

							return yield* Effect.never;
						}),
				}).pipe(Scope.provide(scope));

				const guest = { port: server.port, keyboard: true };
				yield* ssh2Shell(yield* ssh2Client(guest), { cols: 80, rows: 24 });
				yield* waitFor("the first seat", () => seats === 1);
				const late = yield* ssh2Client(guest);

				const protocol = protocolOf(late);
				const shell = protocol.shell.bind(protocol);

				protocol.shell = (channel, wantReply) => {
					setTimeout(() => {
						shell(channel, wantReply);
					}, 300);
				};

				const opened: Array<boolean> = [];
				late.shell(
					{ term: "xterm-256color", cols: 80, rows: 24 },
					(refused) => {
						opened.push(refused === undefined);
					}
				);
				yield* Effect.sleep("100 millis");
				yield* Scope.close(scope, Exit.void);
				expect(seats).toBe(1);
			})
	);

	effect(
		"the session ends when the handler returns, restoring the client's screen",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const { log, onShell } = recorder(Effect.sleep("100 millis"));
				const server = yield* testServer({ onShell });

				const terminal = yield* sshShell(
					server.port,
					{ cols: 80, rows: 24 },
					{ key }
				);

				const exited = yield* Effect.promise(
					async () => await terminal.exited
				).pipe(Effect.timeout("3 seconds"));

				expect(exited).toBe(0);
				expect(log).toEqual(["closed"]);
				expect(terminal.output()).toContain("READY");
				expect(terminal.output()).toContain("\u001B[?1049l");
			})
	);

	effect("the session ends when the handler calls close()", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			const log: Array<string> = [];

			const server = yield* testServer({
				onShell: (session) =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								log.push("closed");
							})
						);
						session.renderer.keyInput.on("keypress", (pressed) => {
							if (pressed.name === "q") {
								session.close();
							}
						});
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

			yield* waitFor("the session", () => terminal.output().includes("READY"));
			terminal.write("q");

			const exited = yield* Effect.promise(
				async () => await terminal.exited
			).pipe(Effect.timeout("3 seconds"));

			expect(exited).toBe(0);
			expect(log).toEqual(["closed"]);
		})
	);

	effect(
		"a client that leaves while its renderer is set up is not logged as a failure",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const logged: Array<string> = [];

				const collect = Logger.make(({ logLevel, message }) => {
					logged.push(`${logLevel}: ${String(message)}`);
				});

				const server = yield* testServer({ onShell: () => Effect.never }).pipe(
					Effect.provideService(Logger.CurrentLoggers, new Set([collect]))
				);

				const client = yield* ssh2Client({ port: server.port, key });

				for (let i = 0; i < 10; i += 1) {
					const channel = yield* ssh2Shell(client, { cols: 80, rows: 24 });
					channel.close();
				}

				yield* Effect.sleep("500 millis");
				expect(logged.filter((line) => line.startsWith("Error:"))).toEqual([]);
			})
	);

	effect("a handler that dies ends its own session and nobody else's", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			let calls = 0;
			const logged: Array<string> = [];

			const collect = Logger.make(({ logLevel, message }) => {
				logged.push(`${logLevel}: ${String(message)}`);
			});

			const server = yield* testServer({
				onShell: () => Effect.die(new Error("handler blew up")),
				onExec: (session) =>
					Effect.suspend(() => {
						calls += 1;

						return calls === 1
							? Effect.die(new Error("exec blew up"))
							: Effect.sync(() => {
									session.write("still here");

									return 0;
								});
					}),
			}).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collect])));

			const terminal = yield* sshShell(
				server.port,
				{ cols: 80, rows: 24 },
				{ key }
			);

			yield* Effect.promise(async () => await terminal.exited).pipe(
				Effect.timeout("3 seconds")
			);
			const died = yield* sshExec(server.port, ["boom"], { key });
			expect(died.exitCode).toBe(1);
			const next = yield* sshExec(server.port, ["hello"], { key });
			expect(next).toMatchObject({ stdout: "still here", exitCode: 0 });
			const errors = logged.filter((line) => line.startsWith("Error:"));
			expect(errors).toHaveLength(2);
			expect(errors[0]).toContain("handler blew up");
			expect(errors[1]).toContain("exec blew up");
		})
	);
});
