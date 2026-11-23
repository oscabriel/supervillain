import { connect } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";

import { serve } from "@supervillain/ssh";
import type { AttachOptions, RawSession } from "@supervillain/ssh";
import { Effect, Logger } from "effect";

import { answerKnows } from "../../src/host/lobby.ts";
import {
	helloLine,
	KNOWS_SUBSYSTEM,
	knowsAnswerLine,
	readLine,
} from "../../src/relay/protocol.ts";
import { Relay } from "../../src/relay/server.ts";
import type { RelayOptions } from "../../src/relay/server.ts";
import { tempDir } from "../host/tempDir.ts";

export const startRelay = (options: Partial<RelayOptions> = {}) =>
	Effect.gen(function* () {
		const dir = options.dir ?? (yield* tempDir);
		const logs: Array<string> = [];

		const logger = Logger.make(({ message }) => {
			logs.push(
				(Array.isArray(message) ? message : [message]).map(String).join(" ")
			);
		});

		const relay = yield* Relay.make({
			dir,
			playerPort: 0,
			gmPort: 0,
			bind: "127.0.0.1",
			...options,
		}).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));

		return { ...relay, dir, logs };
	});

export interface GmTableOptions {
	readonly knows?:
		| { readonly actors: ReadonlyArray<string>; readonly seated?: number }
		| "silent";
}

const readAll = (stream: RawSession["stream"]): Effect.Effect<string> =>
	Effect.callback((resume) => {
		let text = "";

		stream.on("data", (chunk: Buffer) => {
			text += chunk.toString();
		});

		stream.once("end", () => {
			resume(Effect.succeed(text));
		});
	});

const answerKnowing = (
	session: RawSession,
	knows: { readonly actors: ReadonlyArray<string>; readonly seated?: number }
) =>
	Effect.gen(function* () {
		const [line = ""] = (yield* readAll(session.stream)).split("\n");

		const { answer } = answerKnows(line, knows.actors, knows.seated ?? 1, true);

		session.stream.write(knowsAnswerLine(answer));
		session.exit(0);
	});

export const gmTable = (options: GmTableOptions = {}) =>
	Effect.gen(function* () {
		const keyPath = path.join(yield* tempDir, "host_key");
		const ended: Array<string> = [];
		const asked = { count: 0 };
		const { knows } = options;

		const relaySubsystems =
			knows === undefined
				? {}
				: {
						[KNOWS_SUBSYSTEM]: (session: RawSession) =>
							Effect.suspend(() => {
								asked.count += 1;

								return knows === "silent"
									? Effect.never
									: answerKnowing(session, knows);
							}),
					};

		const server = yield* serve({
			hostKeyPath: keyPath,
			port: 0,
			host: "127.0.0.1",
			onRaw: (session) => table(session, ended),
			relaySubsystems,
		});

		return { server, hostKeyPath: keyPath, ended, asked };
	});

const envText = (env: Readonly<Record<string, string>>) => JSON.stringify(env);

const shellTable = (session: RawSession, who: string) =>
	Effect.gen(function* () {
		const { term, cols, rows, env, client } = session.info;

		session.stream.write(
			`seat ${who} ${term} ${cols}x${rows} pty=${session.pty} env=${envText(env)} client=${client.split("_")[0]}|`
		);

		session.onResize((c, r) => {
			session.stream.write(`resize ${c}x${r}|`);
		});

		session.stream.on("data", (chunk: Buffer) => {
			if (chunk.includes("q")) {
				session.exit(5);
			} else {
				session.stream.write(`echo:${chunk.toString()}|`);
			}
		});

		return yield* Effect.never;
	});

const execTable = (session: RawSession, who: string, command: string) =>
	Effect.gen(function* () {
		if (command === "cat") {
			const input = yield* readAll(session.stream);
			session.stream.write(input.toUpperCase());

			return yield* Effect.sync(() => {
				session.exit(0);
			});
		}

		session.stream.resume();
		session.stream.write(`exec ${who} ${command}\n`);
		session.stderr.write("note\n");

		return yield* command === "wait"
			? Effect.never
			: Effect.sync(() => {
					session.exit(command === "fail" ? 3 : 0);
				});
	});

const table = (session: RawSession, ended: Array<string>) =>
	Effect.gen(function* () {
		const who = session.info.relayedActor ?? "-";

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				ended.push(who);
			})
		);

		const { request } = session;

		if (request.kind === "shell") {
			return yield* shellTable(session, who);
		}

		if (request.kind === "exec") {
			return yield* execTable(session, who, request.command);
		}

		return yield* Effect.sync(() => {
			session.exit(1);
		});
	});

export interface GmLink {
	readonly answer: string;
	readonly socket: Socket;
	readonly closed: () => boolean;
}

const connected = (socket: Socket): Effect.Effect<void> =>
	Effect.callback((resume) => {
		socket.once("connect", () => {
			resume(Effect.void);
		});
	});

export interface Dialed {
	readonly socket: Socket;
	readonly closed: () => boolean;
}

export const dial = (port: number) =>
	Effect.gen(function* () {
		const socket = connect(port, "127.0.0.1");
		let closed = false;

		socket.once("close", () => {
			closed = true;
		});

		socket.on("error", () => {
			socket.destroy();
		});

		yield* connected(socket);

		const dialed: Dialed = { socket, closed: () => closed };

		return dialed;
	});

export const socketClosed = (socket: Socket): Effect.Effect<void> =>
	Effect.callback((resume) => {
		socket.once("close", () => {
			resume(Effect.void);
		});

		socket.resume();
	});

export const linkGm = (
	gm: {
		readonly server: {
			readonly attach: (s: Socket, o?: AttachOptions) => void;
		};
	},
	gmPort: number,
	room: string,
	relayKey: string
) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const { socket, closed } = yield* dial(gmPort);
			socket.write(helloLine(room));

			const answer = yield* readLine(socket).pipe(
				Effect.catchTag("LineError", (failure) =>
					Effect.succeed(`(no answer: ${failure.message})`)
				)
			);

			if (answer === "OK") {
				gm.server.attach(socket, {
					admitRelay: (fp) => fp === relayKey,
					persistent: true,
				});
			}

			const link: GmLink = { answer, socket, closed };

			return link;
		}),
		(link) =>
			Effect.sync(() => {
				link.socket.destroy();
			})
	);
