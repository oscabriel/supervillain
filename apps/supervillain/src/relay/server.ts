import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import {
	addressBucket,
	connectClient,
	isRelayableActor,
	loadHostKey,
	normalizeAddress,
	rateLimiter,
	serve,
	TERMINAL_RESET,
	tokenBuckets,
} from "@supervillain/ssh";
import type {
	ClientLink,
	ClientSession,
	Limits,
	Rate,
	RawSession,
	SshError,
	Timeouts,
} from "@supervillain/ssh";
import {
	Clock,
	Context,
	DateTime,
	Effect,
	FiberSet,
	Function,
	Layer,
	Option,
	Path,
	Predicate,
	Result,
	Schema,
	Scope,
	Semaphore,
} from "effect";
import type { FileSystem } from "effect";

import { lobbyFrame } from "./lobby.ts";
import type { LobbyTable } from "./lobby.ts";
import {
	closedRoomMessage,
	errLine,
	isReservedRoom,
	isRoomName,
	JOIN_HINT,
	KNOWS_NONCE_BYTES,
	KNOWS_SUBSYSTEM,
	knowsQueryLine,
	LINE_TIMEOUT_MS,
	MAX_KNOWS_ANSWER_BYTES,
	OK_LINE,
	parseHello,
	parseKnowsAnswer,
	RELAY_USERNAME,
	RELAYED_ACTOR_ENV,
	RELAYED_CLIENT_ENV,
	readLine,
	TABLE_CLOSED_MESSAGE,
} from "./protocol.ts";
import {
	checkRelayDir,
	claimRoom,
	judgeClaim,
	readRooms,
	touchRoom,
} from "./rooms.ts";
import type { Claim, ClaimPolicy, RoomsError } from "./rooms.ts";

export class RelayError extends Schema.TaggedError<RelayError>()("RelayError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface GmLimits {
	readonly links?: number;
	readonly pendingLinks?: number;
	readonly linksPerAddress?: number;
	readonly linkRate?: Rate;
	readonly maxRooms?: number;
	readonly claimDays?: number;
	readonly claimRate?: Rate;
	readonly siteClaimRate?: Rate;
	readonly lineTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly keepaliveMs?: number;
	readonly keepaliveCount?: number;
}

export interface RelayOptions {
	readonly dir: string;
	readonly playerPort: number;
	readonly gmPort: number;
	readonly bind: string;
	readonly limits?: Limits;
	readonly timeouts?: Timeouts;
	readonly sessionsPerRoom?: number;
	readonly gm?: GmLimits;
	readonly lobby?: {
		readonly deadlineMs?: number;
		readonly idleMs?: number;
	};
}

export interface RelayInfo {
	readonly playerPort: number;
	readonly gmPort: number;
	readonly hostKeyFingerprint: string;
	readonly relayKeyFingerprint: string;
	readonly linkedRooms: () => ReadonlyArray<string>;
}

const PLAYER_LIMITS: Limits = {
	connections: 1024,
	sessions: 1024,
	connectionsPerAddress: 8,
	sessionsPerAddress: 8,
	connectRate: { burst: 20, perSecond: 1 },
};

const SESSIONS_PER_ROOM = 32;

const GM_DEFAULTS = {
	links: 256,
	pendingLinks: 64,
	linksPerAddress: 8,
	linkRate: { burst: 10, perSecond: 1 / 6 },
	maxRooms: 1024,
	claimDays: 180,
	claimRate: { burst: 3, perSecond: 1 / 3600 },
	siteClaimRate: { burst: 10, perSecond: 4 / 3600 },
	lineTimeoutMs: LINE_TIMEOUT_MS,
	readyTimeoutMs: 20_000,
	keepaliveMs: 15_000,
	keepaliveCount: 3,
};

const LOBBY_DEADLINE_MS = 2000;

const LOBBY_CONCURRENCY = 16;

const QUESTIONS_PER_LINK = 4;

const LOBBY_IDLE_MS = 60_000;

const SEAT_TIMEOUT = "10 seconds";

const SHUTDOWN_NOTICE = "The relay is shutting down.";

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const unknownRoomMessage = (room: string): string =>
	isRoomName(room) && !isReservedRoom(room)
		? `There's no table called ${room} here.\n${JOIN_HINT}`
		: JOIN_HINT;

const fullRoomMessage = (room: string): string =>
	`The table ${room} is full right now.`;

const siteOf = (address: string) => {
	const site = addressBucket(address, 48);

	return site === addressBucket(address) ? undefined : site;
};

export const claimLimiter = (perAddress: Rate, perSite: Rate) => {
	const byAddress = tokenBuckets(perAddress);
	const bySite = tokenBuckets(perSite);

	return {
		over: (address: string, now: number): string | undefined => {
			const bucket = addressBucket(address);

			if (!byAddress.has(bucket, now)) {
				return bucket;
			}

			const site = siteOf(address);

			return site !== undefined && !bySite.has(site, now) ? site : undefined;
		},
		spend: (address: string, now: number): void => {
			byAddress.take(addressBucket(address), now);
			const site = siteOf(address);

			if (site !== undefined) {
				bySite.take(site, now);
			}
		},
	};
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface GmLink {
	readonly room: string;
	readonly client: ClientLink;
	alive: boolean;
	sessions: number;
	knows: boolean;
	asking: number;
}

const tableLabel = (table: LobbyTable) =>
	`${table.room} (${table.seated} seated)`;

export const lobbyText = (tables: ReadonlyArray<LobbyTable>): string =>
	[
		`Your table${tables.length === 1 ? "" : "s"} open now: ${tables.map(tableLabel).join(", ")}.`,
		`Join one with its name before the @, as you came here: ssh ${tables[0]?.room ?? "<room>"}@…`,
	].join("\n");

type Picked =
	| { readonly kind: "listed"; readonly room: string }
	| { readonly kind: "named"; readonly name: string; readonly picked: number }
	| { readonly kind: "left" }
	| { readonly kind: "idle" };

const CLEAR = "\u001B[H\u001B[2J";

const CTRL_C = 0x03;

const CTRL_D = 0x04;

const BACKSPACE = 0x08;

const LF = 0x0a;

const CR = 0x0d;

const ESC = 0x1b;

const SS3 = 0x4f;

const CSI = 0x5b;

const DEL = 0x7f;

const ZERO = 0x30;

const NINE = 0x39;

const HYPHEN = 0x2d;

const UPPER_A = 0x41;

const UPPER_Z = 0x5a;

const LOWER_A = 0x61;

const LOWER_Z = 0x7a;

const NUMBER_DIGITS = 3;

const ROOM_NAME_LENGTH = 32;

const LOBBY_TRIES = 5;

const FINAL_LOW = 0x40;

const FINAL_HIGH = 0x7e;

const ARROWS: ReadonlyMap<string, 1 | -1> = new Map([
	["[A", -1],
	["OA", -1],
	["[B", 1],
	["OB", 1],
]);

interface Drawn {
	readonly picked: number;
	readonly typed: string;
	readonly said: string | undefined;
}

interface Resumed {
	readonly picked: number;
	readonly said: string | undefined;
}

interface Picking {
	picked: number;
	typed: string;
	said: string | undefined;
	escape: "no" | "esc" | "body";
	sequence: string;
	afterCr: boolean;
}

type Keyed =
	| { readonly kind: "more" }
	| { readonly kind: "left" }
	| { readonly kind: "chose"; readonly room: string; readonly skip: number }
	| { readonly kind: "named"; readonly name: string; readonly skip: number };

const MORE: Keyed = { kind: "more" };

const isDigit = (byte: number) => byte >= ZERO && byte <= NINE;

const isLetter = (byte: number) =>
	(byte >= LOWER_A && byte <= LOWER_Z) || (byte >= UPPER_A && byte <= UPPER_Z);

const isNumber = (typed: string) => /^\d+$/u.test(typed);

const moveBy = (state: Picking, by: 1 | -1, count: number) => {
	if (count === 0) {
		return;
	}

	state.picked = (state.picked + by + count) % count;
	state.typed = "";
	state.said = undefined;
};

const escaped = (state: Picking, byte: number, count: number): boolean => {
	if (state.escape === "esc") {
		if (byte === CSI || byte === SS3) {
			state.escape = "body";
			state.sequence = String.fromCodePoint(byte);

			return true;
		}

		state.escape = "no";

		return false;
	}

	if (state.escape === "no") {
		return false;
	}

	state.sequence += String.fromCodePoint(byte);

	if (byte >= FINAL_LOW && byte <= FINAL_HIGH) {
		state.escape = "no";
		const by = ARROWS.get(state.sequence);

		if (by !== undefined) {
			moveBy(state, by, count);
		}
	}

	return true;
};

const entered = (
	state: Picking,
	rooms: ReadonlyArray<string>,
	byte: number,
	next: number | undefined,
	at: number
): Keyed => {
	const skip = byte === CR && next === LF ? at + 2 : at + 1;

	if (state.typed !== "" && !isNumber(state.typed)) {
		return { kind: "named", name: state.typed, skip };
	}

	const n = state.typed === "" ? state.picked + 1 : Number(state.typed);
	const room = Number.isInteger(n) && n >= 1 ? rooms[n - 1] : undefined;

	if (room !== undefined) {
		return { kind: "chose", room, skip };
	}

	state.said =
		state.typed === ""
			? "Type your table's room name, then Enter."
			: `There's no ${state.typed} on the list.`;
	state.typed = "";

	return MORE;
};

const typedDigit = (state: Picking, byte: number, count: number) => {
	state.typed += String.fromCodePoint(byte);
	state.said = undefined;
	const n = Number(state.typed);

	if (n >= 1 && n <= count) {
		state.picked = n - 1;
	}
};

const typedName = (state: Picking, byte: number) => {
	state.typed += String.fromCodePoint(byte).toLowerCase();
	state.said = undefined;
};

const typed = (state: Picking, byte: number, count: number) => {
	const numbering = state.typed === "" ? count > 0 : isNumber(state.typed);

	if (isDigit(byte) && numbering) {
		if (state.typed.length < NUMBER_DIGITS) {
			typedDigit(state, byte, count);
		}

		return;
	}

	const naming = state.typed !== "" && !isNumber(state.typed);
	const starts = state.typed === "" && isLetter(byte);
	const goesOn = naming && (isLetter(byte) || isDigit(byte) || byte === HYPHEN);

	if ((starts || goesOn) && state.typed.length < ROOM_NAME_LENGTH) {
		typedName(state, byte);
	}
};

const keyed = (
	state: Picking,
	rooms: ReadonlyArray<string>,
	chunk: Buffer,
	at: number,
	byte: number
): Keyed => {
	const lfOfCrLf = byte === LF && state.afterCr;
	state.afterCr = byte === CR;

	if (byte === CTRL_C || byte === CTRL_D) {
		return { kind: "left" };
	}

	if (escaped(state, byte, rooms.length) || lfOfCrLf) {
		return MORE;
	}

	if (byte === CR || byte === LF) {
		return entered(state, rooms, byte, chunk[at + 1], at);
	}

	if (byte === ESC) {
		state.escape = "esc";
	} else if (byte === DEL || byte === BACKSPACE) {
		state.typed = state.typed.slice(0, -1);
	} else {
		typed(state, byte, rooms.length);
	}

	return MORE;
};

const pickTable = (
	session: RawSession,
	rooms: ReadonlyArray<string>,
	idleMs: number,
	from: Resumed,
	draw: (state: Drawn) => void,
	redraw: (again: (() => void) | undefined) => void
): Effect.Effect<Picked> =>
	Effect.callback((resume) => {
		const { stream } = session;

		const state: Picking = {
			picked: from.picked,
			typed: "",
			said: from.said,
			escape: "no",
			sequence: "",
			afterCr: false,
		};

		const show = () => {
			draw({ picked: state.picked, typed: state.typed, said: state.said });
		};

		const stop = () => {
			clearTimeout(idle);
			redraw(undefined);
			stream.removeListener("data", onData);
			stream.removeListener("end", onEnd);
		};

		const finish = (result: Picked, rest?: Buffer) => {
			stop();
			stream.pause();

			if (rest !== undefined && rest.length > 0) {
				stream.unshift(rest);
			}

			resume(Effect.succeed(result));
		};

		const idleTimer = () =>
			setTimeout(() => {
				finish({ kind: "idle" });
			}, idleMs);

		let idle = idleTimer();

		const onData = (chunk: Buffer) => {
			clearTimeout(idle);
			idle = idleTimer();

			for (const [at, byte] of chunk.entries()) {
				const step = keyed(state, rooms, chunk, at, byte);

				if (step.kind === "left") {
					finish({ kind: "left" });

					return;
				}

				if (step.kind === "chose") {
					finish(
						{ kind: "listed", room: step.room },
						chunk.subarray(step.skip)
					);

					return;
				}

				if (step.kind === "named") {
					finish(
						{ kind: "named", name: step.name, picked: state.picked },
						chunk.subarray(step.skip)
					);

					return;
				}
			}

			show();
		};

		const onEnd = () => {
			finish({ kind: "left" });
		};

		show();
		redraw(show);
		stream.on("data", onData);
		stream.once("end", onEnd);
		stream.resume();

		return Effect.sync(stop);
	});

const listen = (
	server: Server,
	port: number,
	host: string
): Effect.Effect<number, RelayError> =>
	Effect.callback((resume) => {
		const where = `listen on ${host}:${port}`;

		const fail = (failure: RelayError) => {
			resume(Effect.fail(failure));
		};

		if (!(server instanceof EventEmitter)) {
			fail(new RelayError({ message: `${where}: not a server` }));

			return;
		}

		const onError = (cause: Error) => {
			fail(new RelayError({ message: `${where}: ${cause.message}`, cause }));
		};

		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			const address = server.address();

			resume(
				Effect.succeed(
					address === null || Predicate.isString(address) ? port : address.port
				)
			);
		});
	});

const socketClosed = (socket: Socket): Effect.Effect<void> =>
	Effect.callback((resume) => {
		socket.once("close", () => {
			resume(Effect.void);
		});
	});

const serverClosed = (server: Server): Effect.Effect<void> =>
	Effect.callback((resume) => {
		server.close(() => {
			resume(Effect.void);
		});
	});

const clientClosed = (client: ClientLink): Effect.Effect<void> =>
	Effect.callback((resume) => {
		client.onClose(() => {
			resume(Effect.void);
		});
	});

const answerOf = (channel: ClientSession): Effect.Effect<string> =>
	Effect.gen(function* () {
		let text = "";

		channel.stream.on("data", (chunk: Buffer) => {
			text += chunk.toString("latin1");

			if (text.length > MAX_KNOWS_ANSWER_BYTES) {
				channel.close();
			}
		});

		yield* Effect.promise(async () => await channel.ended);

		return text;
	});

const isoTime = (millis: number) =>
	DateTime.formatIso(DateTime.makeUnsafe(millis));

const unseated = (room: string, actor: string, why: string) =>
	Effect.as(
		Effect.logInfo(`room ${room}: couldn't seat ${actor}: ${why}`),
		Option.none<ClientSession>()
	);

interface Sizing {
	size: { readonly cols: number; readonly rows: number };
	resize: ((cols: number, rows: number) => void) | undefined;
}

interface Refused {
	readonly journal: string;
	readonly reason: string;
}

type RelayContext = FileSystem.FileSystem | Path.Path;

const make = (
	options: RelayOptions
): Effect.Effect<
	RelayInfo,
	RelayError | RoomsError | SshError,
	Scope.Scope | RelayContext
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const roomsFile = path.join(options.dir, "rooms.json");
		const gmLimits = { ...GM_DEFAULTS, ...options.gm };
		const sessionsPerRoom = options.sessionsPerRoom ?? SESSIONS_PER_ROOM;
		const lobbyDeadlineMs = options.lobby?.deadlineMs ?? LOBBY_DEADLINE_MS;
		const lobbyIdleMs = options.lobby?.idleMs ?? LOBBY_IDLE_MS;
		yield* checkRelayDir(options.dir);
		yield* readRooms(roomsFile);

		const relayKey = yield* Effect.tryPromise({
			try: async () => await loadHostKey(path.join(options.dir, "relay_key")),
			catch: (cause) =>
				new RelayError({ message: `relay key: ${messageOf(cause)}`, cause }),
		});

		const fibers = yield* FiberSet.make();
		const fork = yield* FiberSet.runtime(fibers)<RelayContext>();
		const run = yield* FiberSet.runtimePromise(fibers)<RelayContext>();
		const clock = yield* Clock.Clock;
		const claims = yield* Semaphore.make(1);
		const claimRate = claimLimiter(gmLimits.claimRate, gmLimits.siteClaimRate);
		const links = new Map<string, GmLink>();
		const pending = new Set<Socket>();
		let accepting = true;

		const linkedNow = () =>
			[...links.values()].flatMap((l) => (l.alive ? [l.room] : []));

		const claimPolicy = (): ClaimPolicy => ({
			maxRooms: gmLimits.maxRooms,
			expireMs: gmLimits.claimDays * DAY_MS,
			linked: new Set(linkedNow()),
		});

		const fullRooms = (room: string) =>
			`room ${room}: refused: the relay holds its most rooms (${gmLimits.maxRooms}), each with a GM linked now`;

		const isOpen = (room: string) => links.get(room)?.alive === true;

		const openChannel = (
			open: () => Promise<ClientSession>,
			settled: () => void
		): Effect.Effect<ClientSession, RelayError> =>
			Effect.callback((resume) => {
				let cancelled = false;

				fork(
					Effect.tryPromise({
						try: open,
						catch: (cause) =>
							new RelayError({ message: messageOf(cause), cause }),
					}).pipe(
						Effect.match({
							onFailure: (failure) => {
								settled();
								resume(Effect.fail(failure));
							},
							onSuccess: (channel) => {
								settled();

								if (cancelled) {
									channel.close();
								} else {
									resume(Effect.succeed(channel));
								}
							},
						})
					)
				);

				return Effect.sync(() => {
					cancelled = true;
				});
			});

		const hold = (
			socket: Socket,
			address: string,
			room: string,
			client: ClientLink,
			made: Exclude<Claim, { readonly full: true }>
		) =>
			Effect.gen(function* () {
				const proven = client.hostKeyFingerprint;
				const { holder, claimed, dropped } = made;

				for (const old of dropped) {
					yield* Effect.logInfo(
						`room ${old.room}: dropped the claim of GM host key ${old.key}, last linked ${isoTime(old.linked)}${old.room === room ? "" : `, to make room for ${room}`}`
					);
				}

				if (holder !== proven) {
					return yield* Effect.logWarning(
						`room ${room}: refused a GM with host key ${proven} from ${address}; ${holder} holds it (supervillain relay forget ${room} releases it)`
					);
				}

				if (claimed) {
					yield* Effect.logInfo(
						`room ${room}: claimed by GM host key ${proven}`
					);
				}

				const link: GmLink = {
					room,
					client,
					alive: true,
					sessions: 0,
					knows: true,
					asking: 0,
				};

				const old = links.get(room);
				links.set(room, link);
				pending.delete(socket);

				yield* Effect.addFinalizer(() =>
					Effect.suspend(() => {
						link.alive = false;

						const renew = touchRoom(roomsFile, room, proven).pipe(
							Effect.catchTag("RoomsError", (failure) =>
								Effect.logError(
									`room ${room}: can't write the room registry: ${failure.message}`
								)
							)
						);

						if (links.get(room) !== link) {
							return renew;
						}

						links.delete(room);

						return Effect.andThen(
							renew,
							Effect.logInfo(`room ${room}: GM link closed`)
						);
					})
				);

				if (old === undefined) {
					yield* Effect.logInfo(`room ${room}: GM linked from ${address}`);
				} else {
					old.alive = false;
					old.client.close();
					yield* Effect.logInfo(
						`room ${room}: GM relinked from ${address}; dropped the old link`
					);
				}

				return yield* clientClosed(client);
			});

		const runLink = (socket: Socket, address: string, room: string) =>
			Effect.gen(function* () {
				const linkFull = () => !links.has(room) && links.size >= gmLimits.links;
				const fullRefusal = `room ${room}: refused: the relay has its most GMs linked (${gmLimits.links})`;
				let refusal: string | undefined;

				const verdictOf = (offered: string) =>
					Effect.gen(function* () {
						const rooms = yield* readRooms(roomsFile);
						const now = yield* Clock.currentTimeMillis;

						return judgeClaim(rooms, room, offered, now, claimPolicy());
					}).pipe(Effect.result);

				const client = yield* connectClient({
					socket,
					username: RELAY_USERNAME,
					privateKey: relayKey.pem,
					readyTimeoutMs: gmLimits.readyTimeoutMs,
					keepaliveMs: gmLimits.keepaliveMs,
					keepaliveCount: gmLimits.keepaliveCount,
					verifyHostKey: async (offered) => {
						const verdict = await run(verdictOf(offered));

						if (Result.isFailure(verdict)) {
							refusal = `room ${room}: can't read the room registry: ${verdict.failure.message}`;

							return false;
						}

						if (linkFull()) {
							refusal = fullRefusal;

							return false;
						}

						const { success } = verdict;

						if (success.kind === "full") {
							refusal = fullRooms(room);
						} else if (success.kind === "held") {
							refusal = `room ${room}: refused a GM with host key ${offered} from ${address}; ${success.holder} holds it (supervillain relay forget ${room} releases it)`;
						}

						return refusal === undefined;
					},
				}).pipe(
					Effect.tapError((failure) => {
						if (refusal !== undefined) {
							return Effect.logWarning(refusal);
						}

						return failure.message.includes("refused this client's key")
							? Effect.logWarning(
									`room ${room}: the GM's host at ${address} refused this relay's key ${relayKey.fingerprint}; the GM pins it with --relay-key or in its relay_known`
								)
							: Effect.logInfo(
									`room ${room}: GM link from ${address} failed: ${failure.message}`
								);
					})
				);

				const proven = client.hostKeyFingerprint;

				const claim = yield* claims.withPermits(1)(
					Effect.gen(function* () {
						if (!accepting || client.closed()) {
							return { gone: true } as const;
						}

						if (linkFull()) {
							return { linkFull: true } as const;
						}

						const now = yield* Clock.currentTimeMillis;

						const fresh =
							judgeClaim(
								yield* readRooms(roomsFile),
								room,
								proven,
								now,
								claimPolicy()
							).kind === "free";

						const over = fresh ? claimRate.over(address, now) : undefined;

						if (over !== undefined) {
							return { tooFast: over } as const;
						}

						const made = yield* claimRoom(
							roomsFile,
							room,
							proven,
							claimPolicy()
						);

						if ("claimed" in made && made.claimed) {
							claimRate.spend(address, now);
						}

						return made;
					})
				);

				if ("gone" in claim) {
					return yield* Effect.void;
				}

				if ("linkFull" in claim) {
					return yield* Effect.logWarning(fullRefusal);
				}

				if ("tooFast" in claim) {
					return yield* Effect.logWarning(
						`room ${room}: refused: ${claim.tooFast} claims rooms too fast`
					);
				}

				if ("full" in claim) {
					return yield* Effect.logWarning(fullRooms(room));
				}

				return yield* hold(socket, address, room, client, claim);
			}).pipe(
				Effect.scoped,
				Effect.catchTags({
					RoomsError: (failure) =>
						Effect.logError(
							`room ${room}: can't read or write the room registry: ${failure.message}`
						),
					SshError: () => Effect.void,
				}),
				Effect.ensuring(
					Effect.sync(() => {
						socket.destroy();
					})
				)
			);

		const judgeHello = (room: string, address: string) =>
			claims.withPermits(1)(
				Effect.gen(function* () {
					if (!links.has(room) && links.size >= gmLimits.links) {
						return Option.some<Refused>({
							journal: `room ${room}: refused: the relay has its most GMs linked (${gmLimits.links})`,
							reason: "the relay has its most GMs linked; try again later",
						});
					}

					const now = yield* Clock.currentTimeMillis;

					const verdict = judgeClaim(
						yield* readRooms(roomsFile),
						room,
						"",
						now,
						claimPolicy()
					);

					if (verdict.kind === "full") {
						return Option.some<Refused>({
							journal: fullRooms(room),
							reason:
								"the relay holds its most rooms, each with a GM linked now",
						});
					}

					const over =
						verdict.kind === "free" ? claimRate.over(address, now) : undefined;

					return over === undefined
						? Option.none<Refused>()
						: Option.some<Refused>({
								journal: `room ${room}: refused: ${over} claims rooms too fast`,
								reason: "this address claims rooms too fast; try again later",
							});
				})
			);

		const gmSockets = new Set<Socket>();
		const linksByAddress = new Map<string, number>();
		const linkAllowed = rateLimiter(gmLimits.linkRate);

		const greet = (
			socket: Socket,
			address: string,
			refuse: (line: string) => void,
			line: string
		) => {
			const hello = parseHello(line);

			if (!hello.ok) {
				return Effect.logInfo(
					`GM link from ${address} refused: ${hello.reason}`
				).pipe(
					Effect.andThen(
						Effect.sync(() => {
							refuse(errLine(hello.reason));
						})
					)
				);
			}

			if (!accepting) {
				return Effect.sync(() => {
					refuse(errLine("the relay is shutting down"));
				});
			}

			return judgeHello(hello.room, address).pipe(
				Effect.flatMap(
					Option.match({
						onSome: (refused) =>
							Effect.andThen(
								Effect.logWarning(refused.journal),
								Effect.sync(() => {
									refuse(errLine(refused.reason));
								})
							),
						onNone: () =>
							Effect.suspend(() => {
								if (socket.destroyed) {
									return Effect.void;
								}

								socket.write(OK_LINE);

								return runLink(socket, address, hello.room);
							}),
					})
				),
				Effect.catchTag("RoomsError", (failure) =>
					Effect.andThen(
						Effect.logError(
							`room ${hello.room}: can't read the room registry: ${failure.message}`
						),
						Effect.sync(() => {
							refuse(errLine("the relay can't read its room registry"));
						})
					)
				)
			);
		};

		const onGmSocket = (socket: Socket) => {
			const address = normalizeAddress(socket.remoteAddress);
			const bucket = addressBucket(address);

			socket.on("error", () => {
				socket.destroy();
			});

			const fromHere = linksByAddress.get(bucket) ?? 0;

			if (
				!accepting ||
				pending.size >= gmLimits.pendingLinks ||
				fromHere >= gmLimits.linksPerAddress ||
				!linkAllowed(bucket, clock.currentTimeMillisUnsafe())
			) {
				socket.destroy();

				return;
			}

			gmSockets.add(socket);
			pending.add(socket);
			linksByAddress.set(bucket, fromHere + 1);

			socket.once("close", () => {
				gmSockets.delete(socket);
				pending.delete(socket);
				const left = (linksByAddress.get(bucket) ?? 1) - 1;

				if (left <= 0) {
					linksByAddress.delete(bucket);
				} else {
					linksByAddress.set(bucket, left);
				}
			});

			socket.setNoDelay(true);

			const refuse = (line: string) => {
				socket.end(line);
				setTimeout(() => {
					socket.destroy();
				}, 1000).unref();
			};

			fork(
				readLine(socket, gmLimits.lineTimeoutMs).pipe(
					Effect.matchEffect({
						onFailure: (failure) =>
							Effect.logDebug(
								`GM link from ${address} gone before its hello: ${failure.message}`
							).pipe(
								Effect.andThen(
									Effect.sync(() => {
										socket.destroy();
									})
								)
							),
						onSuccess: (line) => greet(socket, address, refuse, line),
					})
				)
			);
		};

		const gmServer = createServer(onGmSocket);

		const gmPort = yield* Effect.acquireRelease(
			listen(gmServer, options.gmPort, options.bind),
			() =>
				Effect.gen(function* () {
					accepting = false;

					for (const link of links.values()) {
						link.alive = false;
						link.client.close();
					}

					yield* Effect.forEach([...gmSockets], socketClosed, {
						concurrency: "unbounded",
						discard: true,
					}).pipe(Effect.timeoutOption("300 millis"));

					for (const socket of gmSockets) {
						socket.destroy();
					}

					yield* serverClosed(gmServer);
				})
		);

		const seat = (
			link: GmLink,
			session: RawSession,
			env: Readonly<Record<string, string>>,
			size: { readonly cols: number; readonly rows: number }
		) =>
			Effect.acquireRelease(
				openChannel(
					async () =>
						await link.client.open(
							session.request,
							env,
							session.pty ? { term: session.info.term, ...size } : false
						),
					Function.constVoid
				).pipe(Effect.timeout(SEAT_TIMEOUT)),
				(opened) =>
					Effect.sync(() => {
						opened.close();
					}),
				{ interruptible: true }
			);

		const ask = (link: GmLink, actor: string) =>
			Effect.gen(function* () {
				if (!link.alive || !link.knows || link.asking >= QUESTIONS_PER_LINK) {
					return Option.none<LobbyTable>();
				}

				link.asking += 1;
				let held = 2;

				const done = () => {
					held -= 1;

					if (held === 0) {
						link.asking -= 1;
					}
				};

				yield* Effect.addFinalizer(() => Effect.sync(done));

				const opened = yield* Effect.acquireRelease(
					openChannel(
						async () =>
							await link.client.open(
								{ kind: "subsystem", name: KNOWS_SUBSYSTEM },
								{},
								false
							),
						done
					),
					(channel) =>
						Effect.sync(() => {
							channel.close();
						}),
					{ interruptible: true }
				).pipe(Effect.result);

				if (Result.isFailure(opened)) {
					if (opened.failure.message.startsWith("Unable to start subsystem")) {
						if (link.knows) {
							yield* Effect.logInfo(
								`room ${link.room}: its host doesn't answer the lobby (older)`
							);
						}

						link.knows = false;
					}

					return Option.none<LobbyTable>();
				}

				const channel = opened.success;
				channel.stderr.resume();
				channel.stream.end(
					knowsQueryLine(actor, randomBytes(KNOWS_NONCE_BYTES))
				);

				const answer = parseKnowsAnswer(yield* answerOf(channel));

				return answer.known
					? Option.some<LobbyTable>({ room: link.room, seated: answer.seated })
					: Option.none<LobbyTable>();
			}).pipe(Effect.scoped);

		const tablesFor = (actor: string) =>
			Effect.gen(function* () {
				const asked = [...links.values()].filter((l) => l.alive);
				const found: Array<LobbyTable> = [];

				yield* Effect.forEach(
					asked,
					(link) =>
						ask(link, actor).pipe(
							Effect.tap((table) =>
								Effect.sync(() => {
									if (Option.isSome(table)) {
										found.push(table.value);
									}
								})
							),
							Effect.ignoreCause
						),
					{ concurrency: LOBBY_CONCURRENCY, discard: true }
				).pipe(Effect.timeoutOption(lobbyDeadlineMs));

				return found.toSorted((a, b) => (a.room < b.room ? -1 : 1));
			});

		const claimed = (room: string) =>
			isRoomName(room) && !isReservedRoom(room)
				? readRooms(roomsFile).pipe(
						Effect.map((rooms) => rooms[room] !== undefined),
						Effect.catchTag("RoomsError", (failure) =>
							Effect.as(
								Effect.logError(
									`can't read the room registry: ${failure.message}`
								),
								true
							)
						)
					)
				: Effect.succeed(false);

		const turnedDown = (room: string) =>
			Effect.map(claimed(room), (held) =>
				held ? closedRoomMessage(room) : `There's no table called ${room} here.`
			);

		const lobby = (
			session: RawSession,
			asked: string,
			terminal: boolean,
			say: (text: string) => void,
			sizing: Sizing
		) =>
			Effect.gen(function* () {
				const { info } = session;
				const id = info.identity;
				const { actor } = id;

				const turnAway = (code: number, text?: string) => {
					if (text !== undefined) {
						say(text);
					}

					session.exit(code);

					return Option.none<string>();
				};

				if (yield* claimed(asked)) {
					return turnAway(1, closedRoomMessage(asked));
				}

				const tables =
					id.kind === "key" && isRelayableActor(actor)
						? yield* tablesFor(actor)
						: [];

				yield* Effect.logDebug(
					`lobby: ${actor} from ${info.remoteAddress}: ${tables.length} open tables know the key`
				);

				if (!terminal) {
					return turnAway(
						1,
						tables.length === 0 ? unknownRoomMessage(asked) : lobbyText(tables)
					);
				}

				const you = {
					key:
						id.kind === "key"
							? { fingerprint: id.fingerprint, algorithm: id.algorithm }
							: undefined,
					term: info.term,
				};

				const rooms = tables.map((t) => t.room);
				let drawn = "";
				let from: Resumed = { picked: 0, said: undefined };

				const draw = (state: Drawn) => {
					const frame = lobbyFrame(
						{ tables, ...state, you },
						sizing.size.cols,
						sizing.size.rows
					);

					if (frame !== drawn) {
						drawn = frame;
						session.stream.write(frame);
					}
				};

				for (let tries = 0; tries < LOBBY_TRIES; tries += 1) {
					const picked = yield* pickTable(
						session,
						rooms,
						lobbyIdleMs,
						from,
						draw,
						(again) => {
							sizing.resize =
								again === undefined
									? undefined
									: () => {
											again();
										};
						}
					);

					if (picked.kind === "left") {
						session.stream.write(CLEAR);

						return turnAway(0);
					}

					if (picked.kind === "idle") {
						session.stream.write(CLEAR);

						return turnAway(1, "No table picked; come back any time.");
					}

					const room = picked.kind === "listed" ? picked.room : picked.name;

					if (picked.kind === "listed" || isOpen(room)) {
						session.stream.write(CLEAR);
						say(`Joining ${room}…`);

						return Option.some(room);
					}

					yield* Effect.logDebug(
						`lobby: ${actor} from ${info.remoteAddress} asked for ${room}, which isn't open`
					);
					from = { picked: picked.picked, said: yield* turnedDown(room) };
				}

				session.stream.write(CLEAR);

				return turnAway(1, JOIN_HINT);
			});

		const seatIn = (
			session: RawSession,
			room: string,
			terminal: boolean,
			say: (text: string) => void,
			sizing: Sizing
		) =>
			Effect.gen(function* () {
				const { info } = session;
				const { actor } = info.identity;
				const link = links.get(room);

				if (link?.alive !== true) {
					say(closedRoomMessage(room));
					session.exit(1);

					return;
				}

				if (!isRelayableActor(actor)) {
					say("The relay can't seat you.");
					session.exit(1);

					return;
				}

				if (link.sessions >= sessionsPerRoom) {
					yield* Effect.logInfo(
						`room ${room}: full (${sessionsPerRoom} sessions); turned ${actor} away`
					);
					say(fullRoomMessage(room));
					session.exit(1);

					return;
				}

				link.sessions += 1;

				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						link.sessions -= 1;
					})
				);

				const env = Object.fromEntries([
					[RELAYED_ACTOR_ENV, actor],
					[RELAYED_CLIENT_ENV, info.client],
					...Object.entries(info.env).filter(
						([key]) => key !== RELAYED_ACTOR_ENV && key !== RELAYED_CLIENT_ENV
					),
				]);

				const openedAt = sizing.size;

				const channel = yield* seat(link, session, env, openedAt).pipe(
					Effect.asSome,
					Effect.catchTags({
						RelayError: (failure) => unseated(room, actor, failure.message),
						TimeoutError: (failure) => unseated(room, actor, failure.message),
					})
				);

				if (Option.isNone(channel)) {
					say(
						link.alive
							? "The table couldn't seat you right now."
							: TABLE_CLOSED_MESSAGE
					);
					session.exit(1);

					return;
				}

				const opened = channel.value;

				yield* Effect.logDebug(
					`room ${room}: seated ${actor} from ${info.remoteAddress}`
				);

				sizing.resize = (cols, rows) => {
					opened.resize(cols, rows);
				};

				if (sizing.size !== openedAt) {
					opened.resize(sizing.size.cols, sizing.size.rows);
				}

				session.stream.pipe(opened.stream);
				opened.stream.pipe(session.stream, { end: false });
				opened.stderr.pipe(session.stderr, { end: false });
				const ending = yield* Effect.promise(async () => await opened.ended);
				session.stream.unpipe(opened.stream);

				if (ending !== undefined) {
					session.exit(ending);

					return;
				}

				if (link.alive && !link.client.closed()) {
					session.exit(1);

					return;
				}

				if (terminal) {
					session.stream.write(
						`${TERMINAL_RESET}\r\n${TABLE_CLOSED_MESSAGE}\r\n`
					);
				} else {
					session.stderr.write(`${TABLE_CLOSED_MESSAGE}\n`);
				}

				session.exit(1);
			});

		const bridge = (session: RawSession) =>
			Effect.gen(function* () {
				const { info } = session;
				const asked = info.user.toLowerCase();
				const terminal = session.request.kind === "shell" && session.pty;

				const say = (text: string) => {
					if (terminal) {
						session.stream.write(`${text.replaceAll("\n", "\r\n")}\r\n`);
					} else {
						session.stderr.write(`${text}\n`);
					}
				};

				const sizing: Sizing = {
					size: { cols: info.cols, rows: info.rows },
					resize: undefined,
				};

				session.onResize((cols, rows) => {
					sizing.size = { cols, rows };
					sizing.resize?.(cols, rows);
				});

				const room = isOpen(asked)
					? Option.some(asked)
					: yield* lobby(session, asked, terminal, say, sizing);

				if (Option.isSome(room)) {
					yield* seatIn(session, room.value, terminal, say, sizing);
				}
			});

		const services = Context.omit(Scope.Scope)(
			yield* Effect.context<RelayContext>()
		);

		const players = yield* serve({
			hostKeyPath: path.join(options.dir, "host_key"),
			port: options.playerPort,
			host: options.bind,
			allowGuests: true,
			limits: { ...PLAYER_LIMITS, ...options.limits },
			timeouts: options.timeouts ?? {},
			shutdownNotice: SHUTDOWN_NOTICE,
			onRaw: (session) => bridge(session).pipe(Effect.provideContext(services)),
		});

		const info: RelayInfo = {
			playerPort: players.port,
			gmPort,
			hostKeyFingerprint: players.hostKeyFingerprint,
			relayKeyFingerprint: relayKey.fingerprint,
			linkedRooms: linkedNow,
		};

		return info;
	});

export class Relay extends Context.Service<Relay, RelayInfo>()(
	"supervillain/relay/Relay"
) {
	static readonly make = make;

	static readonly layer = (
		options: RelayOptions
	): Layer.Layer<Relay, RelayError | RoomsError | SshError, RelayContext> =>
		Layer.effect(Relay, Relay.make(options));
}
