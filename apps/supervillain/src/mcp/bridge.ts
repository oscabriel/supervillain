import { lstat } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import nodePath from "node:path";
import type { Readable, Writable } from "node:stream";

import { Effect, Predicate, Schema } from "effect";

import { checkPrivateDir, mcpSocketPath, privateDirOf } from "./socket.ts";
import type { SocketPlace } from "./socket.ts";

export class McpBridgeError extends Schema.TaggedError<McpBridgeError>()(
	"McpBridgeError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export interface BridgeOptions {
	readonly campaignDir: string;
	readonly stdin: Readable;
	readonly stdout: Writable;
	readonly place?: SocketPlace;
}

const NOT_RUNNING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

const codeOf = (cause: unknown): string | undefined =>
	Predicate.isObject(cause) && Predicate.isString(cause.code)
		? cause.code
		: undefined;

const exists = (dir: string): Effect.Effect<boolean> =>
	Effect.tryPromise({
		try: async () => await lstat(dir),
		catch: (cause) =>
			new McpBridgeError({ message: `can't look at ${dir}`, cause }),
	}).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false)
	);

const opened = (
	path: string,
	dir: string
): Effect.Effect<Socket, McpBridgeError> =>
	Effect.callback((resume) => {
		const socket = connect(path);

		const onError = (cause: Error) => {
			socket.destroy();
			const code = codeOf(cause);

			resume(
				Effect.fail(
					new McpBridgeError({
						message:
							code !== undefined && NOT_RUNNING.has(code)
								? `no table is open in ${dir}: open it with \`supervillain host ${dir}\` first`
								: `can't reach the table in ${dir}: ${cause.message}`,
						cause,
					})
				)
			);
		};

		socket.once("error", onError);
		socket.once("connect", () => {
			socket.removeListener("error", onError);
			resume(Effect.succeed(socket));
		});

		return Effect.sync(() => {
			socket.destroy();
		});
	});

const piped = (
	socket: Socket,
	options: BridgeOptions
): Effect.Effect<void, McpBridgeError> =>
	Effect.callback((resume) => {
		const onStdinEnd = () => {
			socket.end();
		};

		const onClose = () => {
			options.stdin.unpipe(socket);
			options.stdin.removeListener("end", onStdinEnd);
			resume(Effect.void);
		};

		const onError = (cause: Error) => {
			resume(
				Effect.fail(
					new McpBridgeError({
						message: `the table's connection broke: ${cause.message}`,
						cause,
					})
				)
			);
		};

		socket.once("close", onClose);
		socket.once("error", onError);
		options.stdin.once("end", onStdinEnd);
		options.stdin.pipe(socket, { end: false });
		socket.pipe(options.stdout, { end: false });

		return Effect.sync(() => {
			options.stdin.unpipe(socket);
			socket.destroy();
		});
	});

export const bridgeMcp = Effect.fn("bridgeMcp")(function* (
	options: BridgeOptions
) {
	const dir = nodePath.resolve(options.campaignDir);
	const path = mcpSocketPath(dir, options.place);
	const privateDir = privateDirOf(path, dir);

	if (privateDir !== undefined && (yield* exists(privateDir))) {
		yield* checkPrivateDir(privateDir);
	}

	const socket = yield* opened(path, dir);

	yield* piped(socket, options);
});
