import { describe, expect } from "bun:test";

import { BoxRenderable, TextRenderable } from "@opentui/core";
import { Effect, Logger } from "effect";

import type { ShellSession } from "../src/index.ts";
import { effect, must } from "./effect.ts";
import { clientKey, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Shell } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

describe("shell", () => {
	effect(
		"a pty client gets a renderer of its size, sees what it draws, and resizes it",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const sessions: Array<ShellSession> = [];

				const server = yield* testServer({
					onShell: (session) =>
						Effect.gen(function* () {
							sessions.push(session);
							session.renderer.root.add(
								new TextRenderable(session.renderer, { content: "HELLO_TABLE" })
							);

							return yield* Effect.never;
						}),
				});

				const terminal = yield* sshShell(
					server.port,
					{ cols: 100, rows: 30 },
					{ key }
				);

				yield* waitFor("the drawn text", () =>
					terminal.output().includes("HELLO_TABLE")
				);
				const session = must(sessions[0], "onShell ran");
				expect(session.info).toMatchObject({
					identity: { actor: `key:${key.fingerprint}` },
					user: "den",
					term: "xterm-256color",
					cols: 100,
					rows: 30,
				});
				expect([session.renderer.width, session.renderer.height]).toEqual([
					100, 30,
				]);

				terminal.resize(120, 40);
				yield* waitFor(
					"the renderer to resize",
					() => session.renderer.width === 120 && session.renderer.height === 40
				);
				terminal.resize(400, 150);
				yield* waitFor(
					"the renderer to clamp",
					() =>
						session.renderer.width === 300 && session.renderer.height === 100
				);
			})
	);

	effect(
		"a window-change that lands while the renderer is being made still sizes it",
		() =>
			Effect.gen(function* () {
				const sessions: Array<ShellSession> = [];

				const server = yield* testServer({
					allowGuests: true,
					onShell: (session) =>
						Effect.sync(() => {
							sessions.push(session);
						}).pipe(Effect.andThen(Effect.never)),
				});

				const client = yield* ssh2Client({ port: server.port, keyboard: true });
				const channel = yield* ssh2Shell(client, { cols: 100, rows: 30 });
				channel.setWindow(40, 120, 0, 0);
				yield* waitFor("the renderer to take the size", () => {
					const renderer = sessions[0]?.renderer;

					return renderer?.width === 120 && renderer.height === 40;
				});
			})
	);

	effect(
		"a frame that fails is said in the log once, and opens no console over the seat",
		() =>
			Effect.gen(function* () {
				const sessions: Array<ShellSession> = [];
				const logged: Array<string> = [];

				const collect = Logger.make(({ message }) => {
					logged.push(String(message));
				});

				const server = yield* testServer({
					allowGuests: true,
					onShell: (session) =>
						Effect.gen(function* () {
							session.renderer.root.add(
								new BoxRenderable(session.renderer, {
									width: 5,
									height: 2,
									renderBefore: () => {
										throw new Error("frame blew up");
									},
								})
							);
							sessions.push(session);

							return yield* Effect.never;
						}),
				}).pipe(
					Effect.provideService(Logger.CurrentLoggers, new Set([collect]))
				);

				const client = yield* ssh2Client({ port: server.port, keyboard: true });
				yield* ssh2Shell(client, { cols: 80, rows: 24 });

				const said = () =>
					logged.filter((line) =>
						line.includes("a frame failed: frame blew up")
					);

				yield* waitFor("the failed frame in the log", () => said().length > 0);
				const { renderer } = must(sessions[0], "onShell ran");

				for (let i = 0; i < 3; i += 1) {
					renderer.requestRender();
					yield* Effect.sleep("60 millis");
				}

				expect(said()).toHaveLength(1);
				expect(renderer.console.visible).toBe(false);
			})
	);

	effect(
		"a dozen shells at once raise no listener warning, which would land on the GM's screen",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const warnings: Array<string> = [];

				const onWarning = (warning: Error) => {
					warnings.push(warning.message);
				};

				process.on("warning", onWarning);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						process.off("warning", onWarning);
					})
				);
				let open = 0;

				const server = yield* testServer({
					onShell: () =>
						Effect.sync(() => {
							open += 1;
						}).pipe(Effect.andThen(Effect.never)),
				});

				const clients = yield* Effect.all(
					Array.from({ length: 6 }, () =>
						ssh2Client({ port: server.port, key })
					),
					{ concurrency: 1 }
				);

				for (const client of clients) {
					yield* ssh2Shell(client, { cols: 80, rows: 24 });
					yield* ssh2Shell(client, { cols: 80, rows: 24 });
				}

				yield* waitFor("twelve seats", () => open === 12, 10_000);
				yield* Effect.sleep("100 millis");
				expect(warnings).toEqual([]);
			}),
		20_000
	);

	effect(
		"a shell reports clicks, drags and the wheel, never every motion of the mouse",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					onShell: (session) =>
						Effect.gen(function* () {
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
				const output = terminal.output();

				for (const mode of [
					"\u001B[?1000h",
					"\u001B[?1002h",
					"\u001B[?1006h",
				]) {
					expect(output).toContain(mode);
				}

				expect(output).not.toContain("\u001B[?1003h");
			})
	);
});
