import { describe, expect } from "bun:test";

import { TextRenderable } from "@opentui/core";
import { Deferred, Effect, Exit, Scope } from "effect";
import type ssh2 from "ssh2";

import { TERMINAL_RESET } from "../src/index.ts";
import type { RawSession } from "../src/index.ts";
import { effect, must } from "./effect.ts";
import { clientKey, sshExec, sshShell, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

const readAll = (session: RawSession) =>
	Effect.callback<string>((resume) => {
		let text = "";
		session.stream.on("data", (chunk: Buffer) => {
			text += chunk.toString();
		});
		session.stream.once("end", () => {
			resume(Effect.succeed(text));
		});
	});

const execEnding = (
	client: InstanceType<typeof ssh2.Client>,
	command: string
) =>
	Effect.callback<{
		stdout: string;
		code: number | null;
		signal?: string | undefined;
	}>((resume) => {
		client.exec(command, (refused, channel) => {
			if (refused !== undefined) {
				resume(Effect.die(refused));

				return;
			}

			let stdout = "";
			let code: number | null = null;
			let signal: string | undefined;
			channel.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
				code = exitCode;
				signal = exitSignal;
			});
			channel.on("close", () => {
				resume(Effect.succeed({ stdout, code, signal }));
			});
		});
	});

describe("raw sessions", () => {
	effect(
		"a raw shell with a pty can become a rendered shell, at the size its terminal is now",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const shown: Array<string> = [];

				const server = yield* testServer({
					onRaw: (session) =>
						Effect.gen(function* () {
							const { asShell } = session;

							if (asShell === undefined) {
								session.stream.write("no shell here\n");
								session.exit(3);

								return;
							}

							session.stream.write("raw first|");

							yield* asShell((shell) =>
								Effect.gen(function* () {
									shown.push(
										`${shell.info.cols}x${shell.info.rows} ${shell.info.identity.actor}`
									);
									shell.renderer.root.add(
										new TextRenderable(shell.renderer, {
											content: "MOUNTED_ON_RAW",
										})
									);

									return yield* Effect.never;
								})
							);
						}),
				});

				const terminal = yield* sshShell(
					server.port,
					{ cols: 90, rows: 25 },
					{ key }
				);

				yield* waitFor("the raw bytes", () =>
					terminal.output().includes("raw first|")
				);
				yield* waitFor("the rendered shell", () =>
					terminal.output().includes("MOUNTED_ON_RAW")
				);
				expect(shown).toEqual([`90x25 key:${key.fingerprint}`]);

				const plain = yield* sshExec(server.port, ["anything"], { key });
				expect(plain).toMatchObject({ stdout: "no shell here\n", exitCode: 3 });
			})
	);

	effect(
		"an exec arrives as bytes both ways: stdin to EOF, stdout, stderr, exit status",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					onRaw: (session) =>
						Effect.gen(function* () {
							const input = yield* readAll(session);
							const { request } = session;
							session.stream.write(
								`${session.info.identity.actor} ${request.kind} ${request.kind === "exec" ? request.command : ""} pty=${session.pty}\n`
							);
							session.stream.write(input.toUpperCase());
							session.stderr.write("to stderr\n");
							session.exit(7);
						}),
				});

				const proc = Bun.spawn(
					[
						"ssh",
						"-F",
						"/dev/null",
						"-p",
						String(server.port),
						"-o",
						"StrictHostKeyChecking=no",
						"-o",
						"UserKnownHostsFile=/dev/null",
						"-o",
						"LogLevel=ERROR",
						"-o",
						"IdentityAgent=none",
						"-o",
						"IdentitiesOnly=yes",
						"-o",
						"BatchMode=yes",
						"-i",
						key.path,
						"den@127.0.0.1",
						"shout",
						"this",
					],
					{ stdin: "pipe", stdout: "pipe", stderr: "pipe" }
				);

				yield* Effect.promise(async () => {
					await proc.stdin.write("hello\nthere\n");
					await proc.stdin.end();
				});

				const [stdout, stderr, exitCode] = yield* Effect.promise(
					async () =>
						await Promise.all([
							new Response(proc.stdout).text(),
							new Response(proc.stderr).text(),
							proc.exited,
						])
				);

				expect(stdout).toBe(
					`key:${key.fingerprint} exec shout this pty=false\nHELLO\nTHERE\n`
				);
				expect(stderr).toBe("to stderr\n");
				expect(exitCode).toBe(7);
			})
	);

	effect(
		"a shell keeps its pty and hears window-changes; no renderer, no newline rewriting",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const sizes: Array<string> = [];

				const server = yield* testServer({
					onRaw: (session) =>
						Effect.gen(function* () {
							const { term, cols, rows } = session.info;
							session.onResize((c, r) => {
								sizes.push(`${c}x${r}`);
								session.stream.write(`resized ${c}x${r}|`);
							});
							session.stream.write(
								`${session.request.kind} ${term} ${cols}x${rows} pty=${session.pty}|`
							);
							session.stream.on("data", (chunk: Buffer) => {
								if (chunk.includes("q")) {
									session.exit(3);
								} else {
									session.stream.write(`echo:${chunk.toString()}|`);
								}
							});

							return yield* Effect.never;
						}),
				});

				const terminal = yield* sshShell(
					server.port,
					{ cols: 100, rows: 30 },
					{ key }
				);

				yield* waitFor("the banner", () =>
					terminal.output().includes("shell xterm-256color 100x30 pty=true|")
				);
				terminal.resize(120, 40);
				yield* waitFor("the resize", () =>
					terminal.output().includes("resized 120x40|")
				);
				terminal.write("x");
				yield* waitFor("the echo", () => terminal.output().includes("echo:x|"));
				terminal.write("q");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					3
				);
				expect(sizes).toEqual(["120x40"]);
			})
	);

	effect("a shell without a pty is handed over as it is, not refused", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");

			const server = yield* testServer({
				noPtyMessage: "never said in raw mode",
				onRaw: (session) =>
					Effect.sync(() => {
						session.stream.write(
							`${session.request.kind} pty=${session.pty}\n`
						);
						session.exit(0);
					}),
			});

			const result = yield* sshExec(server.port, [], { key, flags: ["-T"] });
			expect(result).toMatchObject({
				stdout: "shell pty=false\n",
				exitCode: 0,
			});
			expect(result.stderr).not.toContain("never said");
		})
	);

	effect(
		"an exit signal reaches the client; a handler that returns ends with status 0",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");

				const server = yield* testServer({
					onRaw: (session) =>
						Effect.sync(() => {
							const { request } = session;

							if (request.kind === "exec" && request.command === "die") {
								session.exit({
									signal: "TERM",
									coreDumped: false,
									message: "",
								});
							} else {
								session.stream.write("bye");
							}
						}),
				});

				const client = yield* ssh2Client({ port: server.port, key });
				expect(yield* execEnding(client, "die")).toMatchObject({
					code: null,
					signal: "SIGTERM",
				});
				expect(yield* execEnding(client, "other")).toMatchObject({
					stdout: "bye",
					code: 0,
				});
			})
	);

	effect("the session's scope closes when the client goes", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "alice");
			const closed = yield* Deferred.make<boolean>();
			let started = false;

			const server = yield* testServer({
				onRaw: () =>
					Effect.gen(function* () {
						started = true;
						yield* Effect.addFinalizer(() => Deferred.succeed(closed, true));

						return yield* Effect.never;
					}),
			});

			const terminal = yield* sshShell(
				server.port,
				{ cols: 80, rows: 24 },
				{ key }
			);

			yield* waitFor("the session", () => started);
			terminal.kill();
			yield* Deferred.await(closed).pipe(Effect.timeout("3 seconds"));
		})
	);

	effect(
		"a server that closes tells raw shells its notice and ends them with status 1",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "alice");
				const scope = yield* Scope.make();
				let started = false;

				const server = yield* testServer({
					shutdownNotice: "Closing up.",
					onRaw: () =>
						Effect.sync(() => {
							started = true;
						}).pipe(Effect.andThen(Effect.never)),
				}).pipe(Scope.provide(scope));

				const terminal = yield* sshShell(
					server.port,
					{ cols: 80, rows: 24 },
					{ key }
				);

				yield* waitFor("the session", () => started);
				yield* Scope.close(scope, Exit.void);
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					1
				);
				expect(terminal.output()).toContain(
					`${TERMINAL_RESET}\r\nClosing up.\r\n`
				);
				expect(TERMINAL_RESET).toContain("\u001B[?1049l");
			})
	);

	effect("guests, the env allow-list and SV_ACTOR refusal still apply", () =>
		Effect.gen(function* () {
			const seen: Array<{
				actor: string;
				env: Record<string, string>;
				relayed?: string;
			}> = [];

			const server = yield* testServer({
				allowGuests: true,
				onRaw: (session) =>
					Effect.sync(() => {
						const { actor } = session.info.identity;
						const env = { ...session.info.env };
						const relayed = session.info.relayedActor;
						seen.push(
							relayed === undefined ? { actor, env } : { actor, env, relayed }
						);
						session.exit(0);
					}),
			});

			const client = yield* ssh2Client({ port: server.port, keyboard: true });
			yield* Effect.callback<boolean>((resume) => {
				client.exec(
					"x",
					{
						env: {
							COLORTERM: "truecolor",
							LD_PRELOAD: "/evil.so",
							SV_ACTOR: `key:SHA256:${"A".repeat(43)}`,
						},
					},
					(refused, channel) => {
						if (refused !== undefined) {
							resume(Effect.die(refused));

							return;
						}

						channel.resume();
						channel.on("close", () => {
							resume(Effect.succeed(true));
						});
					}
				);
			});
			expect(seen).toHaveLength(1);
			const only = must(seen[0], "onRaw ran");
			expect(only.actor).toMatch(/^guest:[A-Za-z0-9_-]+$/u);
			expect(only.env).toEqual({ COLORTERM: "truecolor" });
			expect(only.relayed).toBeUndefined();
		})
	);
});
