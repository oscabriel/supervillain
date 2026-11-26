import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import type { Writable } from "node:stream";

import {
	CliRenderEvents,
	createCliRenderer,
	NativeSession,
} from "@opentui/core";
import type { CliRendererErrorEvent } from "@opentui/core";
import { Cause, Deferred, Effect, Exit, FiberSet, Predicate } from "effect";
import type { Scope, Types } from "effect";
import ssh2 from "ssh2";
import type { AuthContext, Connection, ServerChannel } from "ssh2";

import { addressBucket, normalizeAddress } from "./address.ts";
import {
	COMPRESS,
	fingerprintOf,
	IDENT,
	KEX,
	loadHostKey,
	parseKey,
} from "./keys.ts";
import { rateLimiter } from "./rate.ts";
import {
	isRelayableActor,
	isRelayableBucket,
	isRelayableInvite,
} from "./relay.ts";
import { injectSocket } from "./ssh2Internals.ts";
import {
	rendererStreams,
	sanitizePty,
	sanitizeSize,
	TERMINAL_RESET,
	takeEnv,
} from "./terminal.ts";
import type { Pty } from "./terminal.ts";
import { SshError } from "./types.ts";
import type {
	AttachOptions,
	Identity,
	RawExit,
	RawRequest,
	RawSession,
	ServeOptions,
	SessionInfo,
	ShellSession,
	SshServer,
} from "./types.ts";

const DEFAULT_LIMITS = {
	connections: 64,
	connectionsPerAddress: 8,
	sessionsPerConnection: 2,
	sessionsPerRelay: 64,
	sessionsPerAddress: 16,
	sessions: 64,
	sessionRate: { burst: 20, perSecond: 1 },
};

const DEFAULT_TIMEOUTS = {
	loginMs: 20_000,
	sessionStartMs: 10_000,
	keepaliveMs: 15_000,
	keepaliveCount: 3,
};

const REKEY_RATE = { burst: 10, perSecond: 1 / 60 };

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const RESTORE_TIMEOUT_MS = 2000;

const NO_PTY_MESSAGE = "This needs a terminal: connect with ssh -t.";

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const attempt = (run: () => void): boolean => {
	try {
		run();

		return true;
	} catch {
		return false;
	}
};

const printable = (text: string) => JSON.stringify(text);

const crlf = (text: string) => text.replaceAll(/\r?\n/gu, "\r\n");

const CLIENT_CHARS_MAX = 64;

export const clientName = (text: string): string =>
	text
		.replace(/^SSH-[^-]*-/u, "")
		.replaceAll(/[^\u0020-\u007E]/gu, "?")
		.slice(0, CLIENT_CHARS_MAX) || "?";

const valid =
	(check: (text: string) => boolean) =>
	(text: string): string | undefined =>
		check(text) ? text : undefined;

const RELAY_ENV: ReadonlyMap<string, (text: string) => string | undefined> =
	new Map([
		["SV_ACTOR", valid(isRelayableActor)],
		["SV_INVITE", valid(isRelayableInvite)],
		["SV_BUCKET", valid(isRelayableBucket)],
		["SV_CLIENT", clientName],
	]);

const isEmitter = (value: NetServer | EventEmitter): value is EventEmitter =>
	value instanceof EventEmitter;

const settled = async (
	register: (done: () => void) => void
): Promise<boolean> => {
	const { promise, resolve } = Promise.withResolvers<boolean>();

	register(() => {
		resolve(true);
	});

	return await promise;
};

type WriteDone = (error: Error | null | undefined) => void;

const guestId = () => randomBytes(12).toString("base64url");

interface Link {
	readonly socket: Socket;
	readonly address: string;
	readonly bucket: string;
	readonly extraTrust: ReadonlySet<string>;
	readonly admitRelay: ((fingerprint: string) => boolean) | undefined;
	readonly persistent: boolean;
	readonly authenticated: () => void;
	readonly client: string;
}

interface VerifiedKey {
	readonly fingerprint: string;
	readonly algorithm: string;
}

const verifiedKey = (
	ctx: Extract<AuthContext, { method: "publickey" }>
): VerifiedKey | undefined => {
	if (!ctx.signature || !ctx.blob) {
		return undefined;
	}

	const key = parseKey(`${ctx.key.algo} ${ctx.key.data.toString("base64")}`);

	if (
		!key ||
		!Object.is(key.verify(ctx.blob, ctx.signature, ctx.hashAlgo), true)
	) {
		return undefined;
	}

	return { fingerprint: fingerprintOf(ctx.key.data), algorithm: key.type };
};

const acceptQuery = (ctx: Extract<AuthContext, { method: "publickey" }>) => {
	if (ctx.key.algo === "ssh-rsa" && ctx.hashAlgo === "sha256") {
		ctx.key.algo = "rsa-sha2-256";
	} else if (ctx.key.algo === "ssh-rsa" && ctx.hashAlgo === "sha512") {
		ctx.key.algo = "rsa-sha2-512";
	}

	ctx.accept();
};

const closeUnstarted = (client: Connection, session: ssh2.Session): boolean => {
	const protocol = client._protocol;
	const id = session._chanInfo?.outgoing?.id;

	if (protocol?.channelClose === undefined || !Predicate.isNumber(id)) {
		return false;
	}

	attempt(() => {
		session._ending = true;
		protocol.channelClose?.(id);
	});

	return true;
};

const endChannel = (channel: ServerChannel, how: RawExit) => {
	attempt(() => {
		if (Predicate.isNumber(how)) {
			channel.exit(how);
		} else {
			channel.exit(how.signal, how.coreDumped ?? false, how.message ?? "");
		}

		channel.end();
		setTimeout(() => {
			attempt(() => {
				channel.close();
			});
		}, RESTORE_TIMEOUT_MS).unref();
	});
};

const watchChannel = (channel: ServerChannel, client?: Connection) =>
	Effect.gen(function* () {
		const ended = yield* Deferred.make<boolean>();
		const closed = yield* Deferred.make<boolean>();
		const state = { gone: false };

		const end = () => {
			Deferred.doneUnsafe(ended, Exit.succeed(true));
		};

		const onGone = () => {
			state.gone = true;
			Deferred.doneUnsafe(closed, Exit.succeed(true));
			end();
		};

		channel.once("close", onGone);
		channel.on("error", onGone);

		if (client !== undefined) {
			client.once("close", onGone);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					client.removeListener("close", onGone);
				})
			);
		}

		return { ended, closed, end, state };
	});

const execSession = (
	channel: ServerChannel,
	info: SessionInfo,
	command: string,
	onExec: NonNullable<ServeOptions["onExec"]>,
	lineEnds: (text: string) => string
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const { ended, state } = yield* watchChannel(channel);
		channel.resume();
		let status = 1;
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				if (!state.gone) {
					endChannel(channel, status);
				}
			})
		);

		const write = (text: string) => {
			if (!state.gone) {
				channel.write(lineEnds(text));
			}
		};

		const writeError = (text: string) => {
			if (!state.gone) {
				channel.stderr.write(lineEnds(text));
			}
		};

		yield* Effect.raceFirst(
			onExec({ info, command, write, writeError }).pipe(
				Effect.map((code) => {
					status = code;

					return code;
				})
			),
			Deferred.await(ended)
		);
	});

const streamsOf = (channel: ServerChannel, cols: number, rows: number) => {
	const streams = rendererStreams(channel, cols, rows);

	return streams === undefined
		? Effect.die(
				new SshError({ message: "the channel is not a terminal stream" })
			)
		: Effect.succeed(streams);
};

export const serve = (
	options: ServeOptions
): Effect.Effect<SshServer, SshError, Scope.Scope> =>
	Effect.gen(function* () {
		const hostKey = yield* Effect.tryPromise({
			try: async () => await loadHostKey(options.hostKeyPath),
			catch: (e) =>
				new SshError({ message: `host key: ${messageOf(e)}`, cause: e }),
		});

		const limits = { ...DEFAULT_LIMITS, ...options.limits };
		const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
		EventEmitter.defaultMaxListeners = Math.max(
			EventEmitter.defaultMaxListeners,
			limits.sessions + 16
		);
		const trusted = new Set<string>(options.trustedRelayKeys);

		const authMethods: Array<"publickey" | "keyboard-interactive"> =
			options.allowGuests === true
				? ["publickey", "keyboard-interactive"]
				: ["publickey"];

		const sessions = yield* FiberSet.make();
		const fork = yield* FiberSet.runtime(sessions)();
		const connections = new Set<Connection>();
		let accepting = true;
		let openSessions = 0;

		const byAddress = new Map<
			string,
			{ connections: number; sessions: number }
		>();

		const countsFor = (address: string) => {
			let counts = byAddress.get(address);

			if (!counts) {
				byAddress.set(address, (counts = { connections: 0, sessions: 0 }));
			}

			return counts;
		};

		const forget = (address: string) => {
			const counts = byAddress.get(address);

			if (counts && counts.connections === 0 && counts.sessions === 0) {
				byAddress.delete(address);
			}
		};

		const sessionAllowed = rateLimiter(limits.sessionRate);

		const boundQueue = (stream: Writable, socket: Socket, address: string) => {
			const write = stream.write.bind(stream);

			stream.write = (
				chunk: Uint8Array | string,
				encodingOrDone?: BufferEncoding | WriteDone,
				done?: WriteDone
			): boolean => {
				const callback = Predicate.isFunction(encodingOrDone)
					? encodingOrDone
					: done;

				const written = Predicate.isString(encodingOrDone)
					? write(chunk, encodingOrDone, callback)
					: write(chunk, callback);

				if (stream.writableLength > MAX_QUEUED_BYTES && !socket.destroyed) {
					fork(
						Effect.logInfo(
							`ssh: cut ${address}: it stopped reading, with ${stream.writableLength} bytes waiting`
						)
					);
					socket.destroy();
				}

				return written;
			};
		};

		const runSession = (
			label: string,
			release: () => void,
			body: Effect.Effect<void, never, Scope.Scope>
		) =>
			fork(
				body.pipe(
					Effect.scoped,
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logError(
									`ssh session ${label} failed`,
									Cause.pretty(cause)
								)
					),
					Effect.ensuring(Effect.sync(release))
				)
			);

		const onConnection = (client: Connection, link: Link) => {
			if (!accepting) {
				client.end();

				return;
			}

			connections.add(client);
			const remoteAddress = link.address;
			const counts = countsFor(link.bucket);
			let identity: Identity | undefined;
			let user = "";
			let relay = false;
			let connectionSessions = 0;
			let startedSessions = 0;
			let closed = false;
			const live = new Set<() => void>();

			let idle: ReturnType<typeof setTimeout> | undefined;

			const stopIdle = () => {
				clearTimeout(idle);
				idle = undefined;
			};

			const startIdle = () => {
				stopIdle();

				if (!closed && startedSessions === 0 && !link.persistent) {
					idle = setTimeout(() => {
						link.socket.destroy();
					}, timeouts.sessionStartMs);
				}
			};

			client.on("authentication", (ctx) => {
				if (ctx.method === "publickey") {
					if (!ctx.signature) {
						acceptQuery(ctx);

						return;
					}

					const key = verifiedKey(ctx);

					if (!key) {
						ctx.reject(authMethods);

						return;
					}

					identity = {
						kind: "key",
						actor: `key:${key.fingerprint}`,
						fingerprint: key.fingerprint,
						algorithm: key.algorithm,
					};
					relay =
						trusted.has(key.fingerprint) ||
						link.extraTrust.has(key.fingerprint);

					if (!relay && link.admitRelay) {
						relay = link.admitRelay(key.fingerprint);

						if (!relay) {
							identity = undefined;

							ctx.reject(authMethods);

							return;
						}
					}

					user = ctx.username;

					ctx.accept();

					return;
				}

				if (
					ctx.method === "keyboard-interactive" &&
					options.allowGuests === true &&
					!link.admitRelay
				) {
					identity = { kind: "guest", actor: `guest:${guestId()}` };
					user = ctx.username;

					ctx.accept();

					return;
				}

				ctx.reject(authMethods);
			});

			client.once("ready", () => {
				link.authenticated();

				if (!relay) {
					boundQueue(link.socket, link.socket, remoteAddress);
				}

				startIdle();
			});
			const rekeyAllowed = rateLimiter(REKEY_RATE);
			client.on("rekey", () => {
				if (rekeyAllowed("", Date.now())) {
					return;
				}

				fork(Effect.logInfo(`ssh: cut ${remoteAddress}: it rekeys too often`));
				link.socket.destroy();
			});

			const bounded = (channel: ServerChannel) => {
				boundQueue(channel, link.socket, remoteAddress);

				return channel;
			};

			client.on("session", (acceptSession, rejectSession) => {
				const limit = relay
					? limits.sessionsPerRelay
					: limits.sessionsPerConnection;

				if (
					!identity ||
					!accepting ||
					connectionSessions >= limit ||
					openSessions >= limits.sessions ||
					(!relay && counts.sessions >= limits.sessionsPerAddress) ||
					(!relay && !sessionAllowed(link.bucket, Date.now()))
				) {
					rejectSession();

					return;
				}

				const who = identity;
				connectionSessions += 1;
				openSessions += 1;
				counts.sessions += 1;
				let started = false;
				let released = false;

				const release = () => {
					if (released) {
						return;
					}

					released = true;
					clearTimeout(startDeadline);
					live.delete(release);
					connectionSessions -= 1;
					openSessions -= 1;
					counts.sessions -= 1;
					forget(link.bucket);

					if (!started) {
						return;
					}

					startedSessions -= 1;

					if (startedSessions === 0) {
						startIdle();
					}
				};

				live.add(release);

				const start = () => {
					started = true;
					clearTimeout(startDeadline);
					startedSessions += 1;
					stopIdle();
				};

				const session = acceptSession();
				session.once("close", release);

				const startDeadline = setTimeout(() => {
					const closedAlone = closeUnstarted(client, session);
					release();

					if (
						!closedAlone ||
						(startedSessions === 0 && !relay && !link.persistent)
					) {
						link.socket.destroy();
					}
				}, timeouts.sessionStartMs);

				let pty: Pty = sanitizePty(undefined);
				let hasPty = false;
				const env: Record<string, string> = {};
				const relayed = new Map<string, string>();
				let resize: ((cols: number, rows: number) => void) | undefined;

				session.on("pty", (accept, reject, info) => {
					if (started) {
						reject?.();

						return;
					}

					pty = sanitizePty(info);
					hasPty = true;
					accept?.();
				});
				session.on("env", (accept, reject, { key, val }) => {
					if (started) {
						reject?.();

						return;
					}

					const relayedValue = RELAY_ENV.get(key);

					if (relayedValue !== undefined) {
						const taken = relay ? relayedValue(val) : undefined;

						if (taken === undefined) {
							reject?.();
						} else {
							relayed.set(key, taken);
							accept?.();
						}

						return;
					}

					if (takeEnv(env, key, val)) {
						accept?.();
					} else {
						reject?.();
					}
				});
				session.on("window-change", (accept, _reject, info) => {
					accept?.();
					const size = sanitizeSize(info.cols, info.rows, pty);
					pty = { ...pty, ...size };
					resize?.(size.cols, size.rows);
				});

				const info = (): SessionInfo => {
					const base: Types.Mutable<SessionInfo> = {
						identity: who,
						user,
						term: pty.term,
						cols: pty.cols,
						rows: pty.rows,
						env: { ...env },
						remoteAddress,
						client: relayed.get("SV_CLIENT") ?? link.client,
					};

					const relayedActor = relayed.get("SV_ACTOR");

					if (relayedActor !== undefined) {
						base.relayedActor = relayedActor;
						const relayedInvite = relayed.get("SV_INVITE");
						const relayedBucket = relayed.get("SV_BUCKET");

						if (relayedInvite !== undefined) {
							base.relayedInvite = relayedInvite;
						}

						if (relayedBucket !== undefined) {
							base.relayedBucket = relayedBucket;
						}
					}

					return base;
				};

				const mayStart = () =>
					accepting && !started && (!relay || relayed.has("SV_ACTOR"));

				const onResize = (handler: (cols: number, rows: number) => void) => {
					resize = handler;
					handler(pty.cols, pty.rows);
				};

				session.on("shell", (accept, reject) => {
					const { onRaw, onShell } = options;

					if (!mayStart() || (!onRaw && !onShell)) {
						reject?.();

						return;
					}

					start();
					const channel = bounded(accept());

					if (onRaw) {
						const sessionInfo = info();
						const request: RawRequest = { kind: "shell" };

						runSession(
							sessionInfo.identity.actor,
							release,
							rawSession(
								client,
								channel,
								sessionInfo,
								request,
								hasPty,
								onRaw,
								onResize
							)
						);

						return;
					}

					if (!hasPty || !onShell) {
						channel.stderr.write(`${options.noPtyMessage ?? NO_PTY_MESSAGE}\n`);
						endChannel(channel, 1);

						release();

						return;
					}

					const sessionInfo = info();
					runSession(
						sessionInfo.identity.actor,
						release,
						shellSession(client, channel, sessionInfo, onShell, onResize)
					);
				});
				session.on("subsystem", (accept, reject, { name }) => {
					const handler =
						(relay && Object.hasOwn(options.relaySubsystems ?? {}, name)
							? options.relaySubsystems?.[name]
							: undefined) ??
						(mayStart() && Object.hasOwn(options.subsystems ?? {}, name)
							? options.subsystems?.[name]
							: undefined);

					if (!accepting || started || handler === undefined) {
						reject?.();

						return;
					}

					start();
					const channel = bounded(accept());
					const sessionInfo = info();
					const request: RawRequest = { kind: "subsystem", name };
					runSession(
						`${sessionInfo.identity.actor} ${name}`,
						release,
						rawSession(
							client,
							channel,
							sessionInfo,
							request,
							hasPty,
							handler,
							onResize
						)
					);
				});
				session.on("exec", (accept, reject, { command }) => {
					const { onRaw, onExec } = options;

					if (!mayStart() || (!onRaw && !onExec)) {
						reject?.();

						return;
					}

					start();
					const channel = bounded(accept());
					const sessionInfo = info();

					if (onRaw) {
						const request: RawRequest = { kind: "exec", command };

						runSession(
							sessionInfo.identity.actor,
							release,
							rawSession(
								client,
								channel,
								sessionInfo,
								request,
								hasPty,
								onRaw,
								onResize
							)
						);

						return;
					}

					if (!onExec) {
						return;
					}

					runSession(
						sessionInfo.identity.actor,
						release,
						execSession(
							channel,
							sessionInfo,
							command,
							onExec,
							hasPty ? crlf : (text) => text
						)
					);
				});
			});

			client.on("close", () => {
				closed = true;
				stopIdle();
				connections.delete(client);

				for (const release of live) {
					release();
				}
			});
			client.on("error", (e: Error & { level?: string }) => {
				if (e.level === "client-timeout") {
					link.socket.destroy();
				}

				fork(
					Effect.logDebug(
						`ssh connection from ${remoteAddress}: ${printable(e.message)}`
					)
				);
			});
		};

		type Watched = Effect.Success<ReturnType<typeof watchChannel>>;

		const renderOn = (
			channel: ServerChannel,
			info: SessionInfo,
			watched: Watched,
			onResize: (resize: (cols: number, rows: number) => void) => void,
			onShell: (
				session: ShellSession
			) => Effect.Effect<void, never, Scope.Scope>
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const { ended, end, state } = watched;
				const streams = yield* streamsOf(channel, info.cols, info.rows);

				const nativeSession = new NativeSession(channel);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						streams.detach();
					})
				);
				let rendering = false;
				channel.once("close", () => {
					if (!rendering) {
						nativeSession.dispose();
					}
				});

				const created = yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: async () =>
							await createCliRenderer({
								stdin: streams.stdin,
								stdout: streams.stdout,
								width: info.cols,
								height: info.rows,
								nativeSession,
								environment: { TERM: info.term, ...info.env },
								exitOnCtrlC: false,
								exitSignals: [],
								enableMouseMovement: false,
								autoFocus: false,
								consoleMode: "disabled",
								openConsoleOnError: false,
								externalOutputMode: "passthrough",
								targetFps: 30,
							}),
						catch: (e) =>
							new SshError({
								message: `renderer: ${messageOf(e)}`,
								cause: e,
							}),
					}),
					(renderer) =>
						Effect.promise(async () => {
							renderer.destroy();

							if (state.gone) {
								nativeSession.dispose();
							}

							const restored = await Promise.race([
								renderer.closed.then(() => true).catch(() => true),
								Bun.sleep(RESTORE_TIMEOUT_MS).then(() => false),
							]);

							if (!restored) {
								nativeSession.dispose();
							}
						})
				).pipe(
					Effect.catchTag("SshError", (e) =>
						state.gone
							? Effect.as(
									Effect.logDebug(
										`ssh shell for ${info.identity.actor}: ${e.message}`
									),
									undefined
								)
							: Effect.die(e)
					)
				);

				if (created === undefined) {
					return;
				}

				rendering = true;
				const live = created;
				live.on(CliRenderEvents.DESTROY, end);
				let failure = "";
				live.on(
					CliRenderEvents.RENDER_ERROR,
					({ error }: CliRendererErrorEvent) => {
						if (error.message === failure) {
							return;
						}

						failure = error.message;
						fork(
							Effect.logError(
								`ssh shell for ${info.identity.actor}: a frame failed: ${failure}`
							)
						);
					}
				);
				onResize((cols, rows) => {
					streams.stdout.columns = cols;
					streams.stdout.rows = rows;
					live.requestResize(cols, rows);
				});

				if (state.gone) {
					return;
				}

				yield* Effect.raceFirst(
					onShell({ info, renderer: live, close: end }),
					Deferred.await(ended)
				);
			});

		const shellSession = (
			client: Connection,
			channel: ServerChannel,
			info: SessionInfo,
			onShell: NonNullable<ServeOptions["onShell"]>,
			onResize: (resize: (cols: number, rows: number) => void) => void
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const watched = yield* watchChannel(channel, client);
				const { closed, state } = watched;

				yield* Effect.addFinalizer(() =>
					Effect.suspend(() => {
						if (state.gone) {
							return Effect.void;
						}

						if (!accepting && options.shutdownNotice !== undefined) {
							channel.write(crlf(`${options.shutdownNotice}\n`));
						}

						endChannel(channel, 0);

						if (accepting) {
							return Effect.void;
						}

						return Deferred.await(closed).pipe(
							Effect.timeout(RESTORE_TIMEOUT_MS),
							Effect.ignore
						);
					})
				);

				yield* renderOn(channel, info, watched, onResize, onShell);
			});

		const rawSession = (
			client: Connection,
			channel: ServerChannel,
			info: SessionInfo,
			request: RawRequest,
			pty: boolean,
			onRaw: NonNullable<ServeOptions["onRaw"]>,
			onResize: (resize: (cols: number, rows: number) => void) => void
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const watched = yield* watchChannel(channel, client);
				const { ended, closed, end, state } = watched;

				let exited = false;
				let status: RawExit = 1;
				yield* Effect.addFinalizer(() =>
					Effect.suspend(() => {
						if (state.gone || exited) {
							return Effect.void;
						}

						exited = true;

						if (
							!accepting &&
							options.shutdownNotice !== undefined &&
							request.kind === "shell"
						) {
							channel.write(
								pty
									? `${TERMINAL_RESET}\r\n${crlf(`${options.shutdownNotice}\n`)}`
									: `${options.shutdownNotice}\n`
							);
						}

						endChannel(channel, status);

						return Deferred.await(closed).pipe(
							Effect.timeout(RESTORE_TIMEOUT_MS),
							Effect.ignore
						);
					})
				);
				const listeners = new Set<(cols: number, rows: number) => void>();
				const size = { cols: info.cols, rows: info.rows };
				onResize((cols, rows) => {
					size.cols = cols;
					size.rows = rows;

					for (const listener of listeners) {
						listener(cols, rows);
					}
				});

				const listen = (listener: (cols: number, rows: number) => void) => {
					listeners.add(listener);
				};

				const exit = (how: RawExit) => {
					if (exited || state.gone) {
						return;
					}

					exited = true;
					endChannel(channel, how);
					end();
				};

				const raw: Types.Mutable<RawSession> = {
					info,
					request,
					pty,
					stream: channel,
					stderr: channel.stderr,
					onResize: listen,
					exit,
				};

				if (pty) {
					raw.asShell = (shell) =>
						Effect.suspend(() => {
							status = 0;

							return renderOn(
								channel,
								{ ...info, cols: size.cols, rows: size.rows },
								watched,
								listen,
								shell
							);
						});
				}

				yield* Effect.raceFirst(
					onRaw(raw).pipe(
						Effect.map(() => {
							status = 0;

							return status;
						})
					),
					Deferred.await(ended)
				);
			});

		const sockets = new Set<Socket>();

		const connectAllowed = options.limits?.connectRate
			? rateLimiter(options.limits.connectRate)
			: () => true;

		const refusalLogged = rateLimiter({ burst: 3, perSecond: 1 / 60 });

		const refusalFor = (
			bucket: string,
			bucketConnections: number
		): string | undefined => {
			if (sockets.size >= limits.connections) {
				return `the server holds its most connections (${limits.connections})`;
			}

			if (bucketConnections >= limits.connectionsPerAddress) {
				return `${bucket} has its most connections open (${limits.connectionsPerAddress})`;
			}

			if (!connectAllowed(bucket, Date.now())) {
				return `${bucket} connects too fast`;
			}

			return undefined;
		};

		const serveSocket = (socket: Socket, attachOptions: AttachOptions = {}) => {
			if (socket.destroyed) {
				return;
			}

			const extraTrust = new Set<string>(attachOptions.trustedRelayKeys);
			const address = normalizeAddress(socket.remoteAddress);
			const bucket = addressBucket(address);
			const counts = countsFor(bucket);

			if (!accepting) {
				forget(bucket);
				socket.destroy();

				return;
			}

			const refusal = refusalFor(bucket, counts.connections);

			if (refusal !== undefined) {
				forget(bucket);

				if (refusalLogged(bucket, Date.now())) {
					fork(
						Effect.logInfo(
							`ssh: refused a connection from ${address}: ${refusal}`
						)
					);
				}

				socket.destroy();

				return;
			}

			sockets.add(socket);
			counts.connections += 1;

			const login = setTimeout(() => {
				socket.destroy();
			}, timeouts.loginMs);

			socket.once("close", () => {
				clearTimeout(login);
				sockets.delete(socket);
				counts.connections -= 1;
				forget(bucket);
			});
			socket.setNoDelay(true);

			const ssh = new ssh2.Server(
				{
					hostKeys: [attachOptions.hostKey ?? hostKey.pem],
					ident: IDENT,
					algorithms: { kex: KEX, compress: COMPRESS },
					keepaliveInterval: timeouts.keepaliveMs,
					keepaliveCountMax: timeouts.keepaliveCount,
				},
				(client, info) => {
					onConnection(client, {
						client: clientName(info.header.identRaw),
						socket,
						address,
						bucket,
						extraTrust,
						admitRelay: attachOptions.admitRelay,
						persistent: attachOptions.persistent === true,
						authenticated: () => {
							clearTimeout(login);
						},
					});
				}
			);

			ssh.on("error", (e: Error) => {
				fork(Effect.logWarning(`ssh server: ${printable(e.message)}`));
			});

			if (!injectSocket(ssh, socket)) {
				fork(Effect.logWarning(`ssh server: ${address} is not a TCP socket`));
				socket.destroy();
			}
		};

		const listener = createServer((socket) => {
			serveSocket(socket);
		});

		if (!isEmitter(listener)) {
			return yield* Effect.die(
				new SshError({ message: "the listener is not an event emitter" })
			);
		}

		const listenerEvents = listener;

		const port = yield* Effect.acquireRelease(
			Effect.callback<number, SshError>((resume) => {
				const onError = (e: Error) => {
					resume(
						Effect.fail(
							new SshError({ message: `listen: ${e.message}`, cause: e })
						)
					);
				};

				listenerEvents.once("error", onError);
				listener.listen(options.port, options.host, () => {
					listenerEvents.removeListener("error", onError);
					listenerEvents.on("error", (e: Error) => {
						fork(Effect.logWarning(`ssh listener: ${e.message}`));
					});
					const address = listener.address();
					resume(
						Effect.succeed(
							address === null || Predicate.isString(address)
								? options.port
								: address.port
						)
					);
				});
			}),
			() =>
				Effect.promise(async () => {
					accepting = false;

					for (const client of connections) {
						attempt(() => {
							client.end();
						});
					}

					const closing = Array.from(
						sockets,
						async (socket) =>
							await settled((done) => {
								socket.once("close", done);
							})
					);

					await Promise.race([Promise.all(closing), Bun.sleep(250)]);

					for (const socket of sockets) {
						socket.destroy();
					}

					await settled((done) => {
						listener.close(done);
					});
				})
		);

		yield* Effect.addFinalizer(() =>
			Effect.suspend(() => {
				accepting = false;

				return FiberSet.clear(sessions);
			})
		);

		const attach = (socket: Socket, attachOptions?: AttachOptions) => {
			serveSocket(socket, attachOptions);
		};

		return {
			port,
			hostKeyFingerprint: hostKey.fingerprint,
			attach,
		} satisfies SshServer;
	});
