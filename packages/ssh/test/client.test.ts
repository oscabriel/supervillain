import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { Deferred, Effect, Exit, Scope } from "effect";

import { connectClient } from "../src/index.ts";
import type { RawSession } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, waitFor } from "./openssh.ts";
import { testServer } from "./server.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

const dial = (port: number) =>
	Effect.callback<Socket>((resume) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			resume(Effect.succeed(socket));
		});
	});

const drain = (stream: NodeJS.ReadableStream) =>
	Effect.callback<string>((resume) => {
		let text = "";
		stream.on("data", (chunk: Buffer) => {
			text += chunk.toString();
		});
		stream.once("end", () => {
			resume(Effect.succeed(text));
		});
	});

const envText = (env: Readonly<Record<string, string>>): string =>
	JSON.stringify(env);

const trust = async (): Promise<boolean> => await Promise.resolve(true);

const distrust = async (): Promise<boolean> => await Promise.resolve(false);

const refusalOf = async (opening: Promise<unknown>): Promise<string> => {
	try {
		await opening;

		return "opened";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

describe("connectClient", () => {
	effect(
		"speaks SSH over a socket it's handed: env first, a pty, exec, both streams, exit",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					trustedRelayKeys: [key.fingerprint],
					onRaw: (session) =>
						Effect.gen(function* () {
							const { request } = session;

							const input = yield* drain(session.stream);

							session.stream.write(
								`${session.info.relayedActor} ${request.kind === "exec" ? request.command : "shell"} ${session.info.term} ${session.info.cols}x${session.info.rows} ${envText(session.info.env)} in=${input}`
							);
							session.stderr.write("err");
							session.exit({ signal: "HUP" });
						}),
				});

				const offered: Array<string> = [];

				const client = yield* connectClient({
					socket: yield* dial(server.port),
					username: "relay",
					privateKey: yield* Effect.promise(
						async () => await readFile(key.path)
					),
					verifyHostKey: async (fingerprint) => {
						offered.push(fingerprint);

						return await trust();
					},
				});

				expect(offered).toEqual([server.hostKeyFingerprint]);
				expect(client.hostKeyFingerprint).toBe(server.hostKeyFingerprint);

				const channel = yield* Effect.promise(
					async () =>
						await client.open(
							{ kind: "exec", command: "go" },
							{ SV_ACTOR: PLAYER, COLORTERM: "truecolor" },
							{
								term: "xterm",
								cols: 90,
								rows: 20,
							}
						)
				);

				channel.stream.end("typed");

				const [out, err, ending] = yield* Effect.all(
					[
						drain(channel.stream),
						drain(channel.stderr),
						Effect.promise(async () => await channel.ended),
					],
					{ concurrency: "unbounded" }
				);

				expect(out).toBe(
					`${PLAYER} go xterm 90x20 {"COLORTERM":"truecolor"} in=typed`
				);
				expect(err).toBe("err");
				expect(ending).toEqual({
					signal: "HUP",
					coreDumped: false,
					message: "",
				});
			})
	);

	effect("a shell hears resizes; the link says when it closes", () =>
		Effect.gen(function* () {
			const key = yield* clientKey(yield* tempDir, "relay");

			const server = yield* testServer({
				trustedRelayKeys: [key.fingerprint],
				onRaw: (session) =>
					Effect.gen(function* () {
						session.onResize((cols, rows) => {
							session.stream.write(`${cols}x${rows}`);
						});
						session.stream.resume();

						return yield* Effect.never;
					}),
			});

			const scope = yield* Scope.make();

			const client = yield* connectClient({
				socket: yield* dial(server.port),
				username: "relay",
				privateKey: yield* Effect.promise(async () => await readFile(key.path)),
				verifyHostKey: trust,
			}).pipe(Scope.provide(scope));

			const closed = yield* Deferred.make<boolean>();
			client.onClose(() => {
				Deferred.doneUnsafe(closed, Exit.succeed(true));
			});

			const channel = yield* Effect.promise(
				async () =>
					await client.open(
						{ kind: "shell" },
						{ SV_ACTOR: PLAYER },
						{ term: "xterm", cols: 80, rows: 24 }
					)
			);

			let seen = "";
			channel.stream.on("data", (chunk: Buffer) => {
				seen += chunk.toString();
			});
			channel.resize(132, 43);
			yield* waitFor("the resize", () => seen === "132x43");
			yield* Scope.close(scope, Exit.void);
			yield* Deferred.await(closed);
			expect(
				yield* Effect.promise(async () => await channel.ended)
			).toBeUndefined();
			expect(client.closed()).toBe(true);
		})
	);

	effect(
		"a relay asks for a subsystem the server names; any other name is refused",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					trustedRelayKeys: [key.fingerprint],
					relaySubsystems: {
						"ask@test": (session) =>
							Effect.gen(function* () {
								const input = yield* drain(session.stream);

								const { request, info } = session;
								session.stream.write(
									`${request.kind === "subsystem" ? request.name : "?"} ${info.relayedActor ?? "-"} in=${input}`
								);
								session.exit(0);
							}),
					},
				});

				const client = yield* connectClient({
					socket: yield* dial(server.port),
					username: "relay",
					privateKey: yield* Effect.promise(
						async () => await readFile(key.path)
					),
					verifyHostKey: trust,
				});

				const channel = yield* Effect.promise(
					async () =>
						await client.open(
							{ kind: "subsystem", name: "ask@test" },
							{},
							false
						)
				);

				channel.stream.end("q");

				const [out, ending] = yield* Effect.all(
					[
						drain(channel.stream),
						Effect.promise(async () => await channel.ended),
					],
					{ concurrency: "unbounded" }
				);

				expect(out).toBe("ask@test - in=q");
				expect(ending).toBe(0);

				const refused = yield* Effect.promise(
					async () =>
						await refusalOf(
							client.open({ kind: "subsystem", name: "other@test" }, {}, false)
						)
				);

				expect(refused).toContain("Unable to start subsystem");
				expect(client.closed()).toBe(false);
			})
	);

	effect("a player's connection can't ask for a relay's subsystem", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const key = yield* clientKey(dir, "player");

			const server = yield* testServer({
				relaySubsystems: {
					"ask@test": (session) =>
						Effect.sync(() => {
							session.exit(0);
						}),
				},
			});

			const client = yield* connectClient({
				socket: yield* dial(server.port),
				username: "den",
				privateKey: yield* Effect.promise(async () => await readFile(key.path)),
				verifyHostKey: trust,
			});

			const refused = yield* Effect.promise(
				async () =>
					await refusalOf(
						client.open({ kind: "subsystem", name: "ask@test" }, {}, false)
					)
			);

			expect(refused).toContain("Unable to start subsystem");
		})
	);

	const echoActor = {
		"agent@test": (session: RawSession) =>
			Effect.sync(() => {
				const { identity, relayedActor } = session.info;
				session.stream.write(`${identity.actor} as ${relayedActor ?? "-"}`);
				session.exit(0);
			}),
	};

	effect(
		"a player's own connection opens an actor-bearing subsystem as their key",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "player");
				const server = yield* testServer({ subsystems: echoActor });

				const client = yield* connectClient({
					socket: yield* dial(server.port),
					username: "den",
					privateKey: yield* Effect.promise(
						async () => await readFile(key.path)
					),
					verifyHostKey: trust,
				});

				const channel = yield* Effect.promise(
					async () =>
						await client.open(
							{ kind: "subsystem", name: "agent@test" },
							{},
							false
						)
				);

				channel.stream.end();

				expect(yield* drain(channel.stream)).toBe(
					`key:${key.fingerprint} as -`
				);
				expect(yield* Effect.promise(async () => await channel.ended)).toBe(0);

				const other = yield* Effect.promise(
					async () =>
						await refusalOf(
							client.open({ kind: "subsystem", name: "other@test" }, {}, false)
						)
				);

				expect(other).toContain("Unable to start subsystem");
			})
	);

	effect(
		"a relay opens an actor-bearing subsystem only for the player it names in SV_ACTOR",
		() =>
			Effect.gen(function* () {
				const key = yield* clientKey(yield* tempDir, "relay");

				const server = yield* testServer({
					trustedRelayKeys: [key.fingerprint],
					subsystems: echoActor,
				});

				const client = yield* connectClient({
					socket: yield* dial(server.port),
					username: "relay",
					privateKey: yield* Effect.promise(
						async () => await readFile(key.path)
					),
					verifyHostKey: trust,
				});

				const channel = yield* Effect.promise(
					async () =>
						await client.open(
							{ kind: "subsystem", name: "agent@test" },
							{ SV_ACTOR: PLAYER },
							false
						)
				);

				channel.stream.end();

				expect(yield* drain(channel.stream)).toBe(
					`key:${key.fingerprint} as ${PLAYER}`
				);

				const unnamed = yield* Effect.promise(
					async () =>
						await refusalOf(
							client.open({ kind: "subsystem", name: "agent@test" }, {}, false)
						)
				);

				expect(unnamed).toContain("Unable to start subsystem");
			})
	);

	effect(
		"a host key the caller refuses, or a key the server refuses, fails the connect",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const key = yield* clientKey(dir, "relay");
				const server = yield* testServer({});

				const privateKey = yield* Effect.promise(
					async () => await readFile(key.path)
				);

				const refusedHost = yield* Effect.flip(
					connectClient({
						socket: yield* dial(server.port),
						username: "relay",
						privateKey,
						verifyHostKey: distrust,
					})
				);

				expect(refusedHost.message).toContain("host key");
				const farEnd = yield* Deferred.make<Socket>();

				const relay = yield* tcpListener((socket) => {
					Deferred.doneUnsafe(farEnd, Effect.succeed(socket));
				});

				server.attach(connect(relay.port, "127.0.0.1"), {
					admitRelay: () => false,
				});

				const refusedKey = yield* Effect.flip(
					connectClient({
						socket: yield* Deferred.await(farEnd),
						username: "relay",
						privateKey,
						verifyHostKey: trust,
					})
				);

				expect(refusedKey.message).toContain("refused this client's key");
			})
	);
});
