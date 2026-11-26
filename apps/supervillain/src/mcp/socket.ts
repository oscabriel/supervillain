import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmod,
	lstat,
	mkdir,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { GM } from "@supervillain/domain";
import {
	Context,
	Data,
	Effect,
	FiberSet,
	Function,
	Layer,
	Predicate,
	Schema,
	Scope,
} from "effect";

import type { McpServices } from "./seat.ts";
import { mcpSession } from "./session.ts";

export const SOCKET_FILE = "mcp.sock";

export const SOCKET_PATH_MOST = 100;

const HASH_LENGTH = 16;

const GROUP_OTHER = 0o100;

const STAGING_PREFIX = ".mcp.";

const STAGING_ROOM = Buffer.byteLength(`${STAGING_PREFIX}4294967295/`);

export class McpSocketError extends Schema.TaggedError<McpSocketError>()(
	"McpSocketError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export interface SocketPlace {
	readonly runtimeDir?: string | undefined;
	readonly tmp?: string;
	readonly uid?: number | undefined;
}

const here = (): SocketPlace => ({
	runtimeDir: process.env.XDG_RUNTIME_DIR,
	tmp: tmpdir(),
	uid: process.getuid?.(),
});

export const mcpSocketPath = (
	campaignDir: string,
	place: SocketPlace = here()
): string => {
	const resolved = nodePath.resolve(campaignDir);
	const direct = nodePath.join(resolved, SOCKET_FILE);

	if (Buffer.byteLength(direct) + STAGING_ROOM <= SOCKET_PATH_MOST) {
		return direct;
	}

	const base =
		place.runtimeDir === undefined || place.runtimeDir === ""
			? (place.tmp ?? tmpdir())
			: place.runtimeDir;

	const hash = createHash("sha256")
		.update(resolved)
		.digest("hex")
		.slice(0, HASH_LENGTH);

	return nodePath.join(
		base,
		`supervillain-${place.uid ?? "user"}`,
		`${hash}.sock`
	);
};

const codeOf = (cause: unknown): string | undefined =>
	Predicate.isObject(cause) && Predicate.isString(cause.code)
		? cause.code
		: undefined;

type Probe = "absent" | "stale" | "live";

const failed = (message: string) => (cause: unknown) =>
	new McpSocketError({ message, cause });

const probeOf = (code: string | undefined): Probe | undefined => {
	if (code === "ENOENT") {
		return "absent";
	}

	return code === "ECONNREFUSED" ? "stale" : undefined;
};

const probe = (path: string): Effect.Effect<Probe, McpSocketError> =>
	Effect.callback((resume) => {
		const socket = connect(path);

		socket.once("connect", () => {
			socket.destroy();
			resume(Effect.succeed("live"));
		});

		socket.once("error", (cause) => {
			socket.destroy();
			const found = probeOf(codeOf(cause));

			resume(
				found === undefined
					? Effect.fail(
							failed(
								`can't check ${path} (${codeOf(cause) ?? "no error code"}); leaving it alone`
							)(cause)
						)
					: Effect.succeed(found)
			);
		});

		return Effect.sync(() => {
			socket.destroy();
		});
	});

export const privateDirOf = (
	path: string,
	campaignDir: string
): string | undefined => {
	const dir = nodePath.dirname(path);

	return dir === nodePath.resolve(campaignDir) ? undefined : dir;
};

export const checkPrivateDir = Effect.fn("McpSocket.checkPrivateDir")(
	function* (dir: string) {
		const info = yield* Effect.tryPromise({
			try: async () => await lstat(dir),
			catch: failed(`can't look at ${dir}`),
		});

		if (!info.isDirectory()) {
			return yield* new McpSocketError({
				message: `${dir} isn't a plain folder (a symlink?); remove it and open the table again`,
			});
		}

		const uid = process.getuid?.();

		if (uid !== undefined && info.uid !== uid) {
			return yield* new McpSocketError({
				message: `${dir} belongs to another user; remove it and open the table again`,
			});
		}

		if (info.mode % GROUP_OTHER !== 0) {
			return yield* new McpSocketError({
				message: `${dir} is open to other users (chmod 700 it)`,
			});
		}

		return dir;
	}
);

const clearStale = Effect.fn("McpSocket.clearStale")(function* (path: string) {
	const found = yield* probe(path);

	if (found === "live") {
		return yield* new McpSocketError({
			message: `another table is already taking agents at ${path}`,
		});
	}

	if (found === "stale") {
		const info = yield* Effect.tryPromise({
			try: async () => await stat(path),
			catch: failed(`can't look at ${path}`),
		});

		if (!info.isSocket()) {
			return yield* new McpSocketError({
				message: `${path} is in the way and isn't a socket; move it and open the table again`,
			});
		}

		yield* Effect.tryPromise({
			try: async () => {
				await unlink(path);
			},
			catch: failed(`can't clear the old ${path}`),
		});
	}

	return found;
});

const ensureDir = Effect.fn("McpSocket.ensureDir")(function* (
	path: string,
	campaignDir: string
) {
	const dir = privateDirOf(path, campaignDir);

	if (dir === undefined) {
		return;
	}

	yield* Effect.tryPromise({
		try: async () => {
			await mkdir(dir, { recursive: true, mode: 0o700 });
		},
		catch: failed(`can't make ${dir} for the agent socket`),
	});

	yield* checkPrivateDir(dir);
});

const listen = (
	server: Server,
	path: string
): Effect.Effect<void, McpSocketError> =>
	Effect.callback((resume) => {
		if (!(server instanceof EventEmitter)) {
			resume(Effect.fail(new McpSocketError({ message: "not a server" })));

			return;
		}

		const onError = (cause: Error) => {
			resume(Effect.fail(failed(`can't listen on ${path}`)(cause)));
		};

		server.once("error", onError);
		server.listen(path, () => {
			server.removeListener("error", onError);
			server.on("error", Function.constVoid);
			resume(Effect.void);
		});
	});

const closeServer = (server: Server): Effect.Effect<void> =>
	Effect.callback((resume) => {
		server.close(() => {
			resume(Effect.void);
		});
	});

export interface McpSocketOptions {
	readonly campaignDir: string;
	readonly room: string;
	readonly place?: SocketPlace;
}

export type AgentSocket = Data.TaggedEnum<{
	Listening: { readonly path: string };
	Unavailable: { readonly problem: string };
}>;

export const AgentSocket = Data.taggedEnum<AgentSocket>();

export class McpSocket extends Context.Service<McpSocket, AgentSocket>()(
	"supervillain/mcp/McpSocket"
) {
	static readonly make = (options: McpSocketOptions) =>
		Effect.gen(function* () {
			const services = Context.omit(Scope.Scope)(
				yield* Effect.context<McpServices>()
			);

			const path = mcpSocketPath(options.campaignDir, options.place);

			const folder = nodePath.join(
				nodePath.dirname(path),
				`${STAGING_PREFIX}${process.pid}`
			);

			const staging = nodePath.join(folder, nodePath.basename(path));

			const clearFolder = Effect.tryPromise({
				try: async () => {
					await rm(folder, { recursive: true, force: true });
				},
				catch: failed(`can't remove ${folder}`),
			}).pipe(Effect.ignore);

			const fork = yield* FiberSet.makeRuntime();
			const open = new Set<Socket>();

			yield* ensureDir(path, options.campaignDir);
			yield* clearStale(path);

			const session = (socket: Socket) => {
				open.add(socket);
				socket.once("close", () => {
					open.delete(socket);
				});
				socket.on("error", () => {
					socket.destroy();
				});

				fork(
					mcpSession({
						actor: GM,
						role: "gm",
						rateKey: GM,
						room: options.room,
						stream: socket,
						close: () => {
							socket.end();
							socket.destroySoon();
						},
					}).pipe(
						Effect.scoped,
						Effect.ensuring(
							Effect.sync(() => {
								socket.destroy();
							})
						),
						Effect.provideContext(services)
					)
				);
			};

			yield* Effect.acquireRelease(
				Effect.gen(function* () {
					const server = createServer(session);

					yield* Effect.tryPromise({
						try: async () => {
							await rm(folder, { recursive: true, force: true });
							await mkdir(folder, { mode: 0o700 });
						},
						catch: failed(`can't make ${folder} for the agent socket`),
					});

					yield* checkPrivateDir(folder).pipe(
						Effect.tapError(() => clearFolder)
					);

					yield* listen(server, staging).pipe(
						Effect.tapError(() => clearFolder)
					);

					yield* Effect.tryPromise({
						try: async () => {
							await chmod(staging, 0o600);
							await rename(staging, path);
						},
						catch: failed(`can't put the agent socket at ${path}`),
					}).pipe(
						Effect.tapError(() => closeServer(server)),
						Effect.ensuring(clearFolder)
					);

					return server;
				}),
				(server) =>
					Effect.gen(function* () {
						for (const socket of open) {
							socket.destroy();
						}

						yield* closeServer(server);
						yield* Effect.tryPromise({
							try: async () => {
								await rm(path, { force: true });
							},
							catch: failed(`can't remove ${path}`),
						}).pipe(Effect.ignore);
					})
			);

			yield* Effect.logInfo(`agents: listening on ${path}`);

			return McpSocket.of(AgentSocket.Listening({ path }));
		});

	static readonly layer = (
		options: McpSocketOptions
	): Layer.Layer<McpSocket, McpSocketError, McpServices> =>
		Layer.effect(McpSocket, McpSocket.make(options));

	static readonly layerBestEffort = (
		options: McpSocketOptions
	): Layer.Layer<McpSocket, never, McpServices> =>
		Layer.effect(
			McpSocket,
			McpSocket.make(options).pipe(
				Effect.catchTag("McpSocketError", (failure) =>
					Effect.as(
						Effect.logWarning(
							`agents: unavailable: ${failure.message}`,
							failure.cause
						),
						McpSocket.of(AgentSocket.Unavailable({ problem: failure.message }))
					)
				)
			)
		);
}

export const agentsLine = (
	self: string,
	dir: string,
	socket: AgentSocket
): string =>
	AgentSocket.$match(socket, {
		Listening: ({ path }) =>
			`agents on this machine connect with: ${self} mcp ${dir} (socket ${path})`,
		Unavailable: ({ problem }) =>
			`agents on this machine: unavailable (${problem})`,
	});
