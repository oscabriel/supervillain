import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import {
	addressBucket,
	connectClient,
	isRelayableActor,
	loadHostKey,
	messageOf,
	normalizeAddress,
	rateLimiter,
	serve,
	serverEvents,
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
import { SecureRandom } from "effect/crypto";

import {
	addKey,
	checkRelayDir,
	claimHandle,
	judgeHandle,
	readHandles,
	retireLegacyRooms,
	touchHandle,
} from "./handles.ts";
import type { Claim, HandlePolicy, HandlesError } from "./handles.ts";
import {
	afterClaim,
	commandsOf,
	commandsText,
	createForm,
	handleProblem,
	lobbyFrame,
	lobbying,
	osc52,
	afterPairing,
	readLobby,
} from "./lobby/index.ts";
import type {
	Claimed,
	CreateAsk,
	Lobbying,
	LobbyTable,
	Paired,
	SandboxNote,
} from "./lobby/index.ts";
import { pairingCodes, PAIRING_BYTES } from "./pairings.ts";
import type { Minted } from "./pairings.ts";
import {
	addressText,
	closedTableMessage,
	errLine,
	isHandle,
	isReservedShortTable,
	JOIN_HINT,
	KNOWS_NONCE_BYTES,
	KNOWS_SUBSYSTEM,
	MCP_SUBSYSTEM,
	knowsQueryLine,
	LINE_TIMEOUT_MS,
	MAX_KNOWS_ANSWER_BYTES,
	OK_LINE,
	parseAddress,
	parseHello,
	parseKnowsAnswer,
	RELAY_USERNAME,
	RELAYED_ACTOR_ENV,
	RELAYED_CLIENT_ENV,
	RELAYED_BUCKET_ENV,
	RELAYED_INVITE_ENV,
	readLine,
	TABLE_CLOSED_MESSAGE,
} from "./protocol.ts";
import {
	minutesOf,
	runSandbox,
	sandboxGate,
	sandboxLimits,
	sizeProblem,
} from "./sandbox.ts";
import type { SandboxOptions } from "./sandbox.ts";

export class RelayError extends Schema.TaggedError<RelayError>()("RelayError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface GmLimits {
	readonly links?: number;
	readonly pendingLinks?: number;
	readonly linksPerAddress?: number;
	readonly linkRate?: Rate;
	readonly maxHandles?: number;
	readonly maxKeysPerHandle?: number;
	readonly tablesPerHandle?: number;
	readonly claimDays?: number;
	readonly unlinkedDays?: number;
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
	readonly sessionsPerTable?: number;
	readonly gm?: GmLimits;
	readonly lobby?: {
		readonly deadlineMs?: number;
		readonly idleMs?: number;
	};
	readonly sandbox?: SandboxOptions;
	readonly publicRelay?: string;
}

export interface RelayInfo {
	readonly playerPort: number;
	readonly gmPort: number;
	readonly hostKeyFingerprint: string;
	readonly relayKeyFingerprint: string;
	readonly linkedTables: () => ReadonlyArray<string>;
	readonly mintPairing: (
		handle: string,
		by: string
	) => Effect.Effect<Minted, HandlesError>;
	readonly claimHandle: (
		handle: string,
		fingerprint: string
	) => Effect.Effect<Claim, HandlesError>;
	readonly sandboxesLive: () => number;
}

const PLAYER_LIMITS: Limits = {
	connections: 1024,
	sessions: 1024,
	connectionsPerAddress: 8,
	sessionsPerAddress: 8,
	connectRate: { burst: 20, perSecond: 1 },
};

const SESSIONS_PER_TABLE = 32;

const GM_DEFAULTS = {
	links: 256,
	pendingLinks: 64,
	linksPerAddress: 8,
	linkRate: { burst: 10, perSecond: 1 / 6 },
	maxHandles: 4096,
	maxKeysPerHandle: 4,
	tablesPerHandle: 8,
	claimDays: 180,
	unlinkedDays: 30,
	claimRate: { burst: 3, perSecond: 1 / 3600 },
	siteClaimRate: { burst: 10, perSecond: 4 / 3600 },
	lineTimeoutMs: LINE_TIMEOUT_MS,
	readyTimeoutMs: 20_000,
	keepaliveMs: 15_000,
	keepaliveCount: 3,
};

const BUCKET_SECRET_BYTES = 32;

const LOBBY_DEADLINE_MS = 2000;

const LOBBY_CONCURRENCY = 16;

const QUESTIONS_PER_LINK = 4;

const LOBBY_IDLE_MS = 60_000;

const SEAT_TIMEOUT = "10 seconds";

const SHUTDOWN_NOTICE = "The relay is shutting down.";

const fullTableMessage = (address: string): string =>
	`${address} is full right now.`;

export const shorthandMessage = (table: string): string =>
	`No open table called ${table} knows your key. Join with its full name, ssh <handle>/${table}@… (your GM has it).`;

export const AGENTS_TOO_OLD = "This table's host is too old to take agents.";

export const manyMessage = (table: string): string =>
	`More than one open table called ${table} knows your key: pick one.`;

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

interface GmLink {
	readonly handle: string;
	readonly table: string;
	readonly address: string;
	readonly key: string;
	readonly client: ClientLink;
	alive: boolean;
	sessions: number;
	knows: boolean;
	asking: number;
}

const lobbyAddress = (table: LobbyTable): string =>
	addressText(table.handle, table.table);

const tableLabel = (table: LobbyTable) =>
	`${lobbyAddress(table)} (${table.seated} seated)`;

export const lobbyText = (tables: ReadonlyArray<LobbyTable>): string =>
	[
		`Your table${tables.length === 1 ? "" : "s"} open now: ${tables.map(tableLabel).join(", ")}.`,
		`Join one with its name before the @: ssh ${tables[0] === undefined ? "<handle>/<table>" : lobbyAddress(tables[0])}@…`,
	].join("\n");

const CLEAR = "\u001B[?25h\u001B[H\u001B[2J";

const LOBBY_TRIES = 5;

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

		const onError = (cause: Error) => {
			fail(new RelayError({ message: `${where}: ${cause.message}`, cause }));
		};

		const events = serverEvents(server);

		events.once("error", onError);
		server.listen(port, host, () => {
			events.removeListener("error", onError);
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

const knowsMe = (session: RawSession) => {
	const id = session.info.identity;

	return id.kind === "key" && isRelayableActor(id.actor);
};

interface Opening {
	readonly said?: string;
	readonly only?: ReadonlyArray<LobbyTable>;
}

interface Wanted {
	readonly handle: string;
	readonly table: string;
	readonly proof?: string;
}

type RelayContext = FileSystem.FileSystem | Path.Path;

const lobbyRefused = (reason: string): Claimed => ({
	kind: "refused",
	reason,
});

const belongsElsewhere = (handle: string) =>
	lobbyRefused(
		`The handle ${handle} belongs to another GM's key; pick another.`
	);

const keptCommands = (state: Lobbying): string | undefined => {
	const { ready } = state.create;

	if (ready === undefined) {
		return undefined;
	}

	return `Run these on your computer (the code works once, for 15 minutes):\n${commandsText(commandsOf(state.create, ready))}`;
};

const make = (
	options: RelayOptions
): Effect.Effect<
	RelayInfo,
	RelayError | HandlesError | SshError,
	Scope.Scope | RelayContext | SecureRandom.SecureRandom
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const random = yield* SecureRandom.SecureRandom;
		const handlesFile = path.join(options.dir, "handles.json");
		const gmLimits = { ...GM_DEFAULTS, ...options.gm };
		const sessionsPerTable = options.sessionsPerTable ?? SESSIONS_PER_TABLE;
		const lobbyDeadlineMs = options.lobby?.deadlineMs ?? LOBBY_DEADLINE_MS;
		const lobbyIdleMs = options.lobby?.idleMs ?? LOBBY_IDLE_MS;
		const sandboxes = sandboxLimits(options.sandbox);
		const gate = sandboxGate(sandboxes);
		yield* checkRelayDir(options.dir);
		const retired = yield* retireLegacyRooms(options.dir);

		if (Option.isSome(retired)) {
			yield* Effect.logWarning(
				`relay: rooms.json is from protocol 1; renamed it ${retired.value}. GMs claim handles afresh in handles.json`
			);
		}

		yield* readHandles(handlesFile);

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
		const pairings = pairingCodes();
		const bucketSecret = yield* random.randomBytes(BUCKET_SECRET_BYTES);

		const bucketOf = (address: string) =>
			createHmac("sha256", bucketSecret)
				.update(addressBucket(address))
				.digest("base64url");

		const links = new Map<string, GmLink>();
		const byTable = new Map<string, Set<string>>();
		const pending = new Set<Socket>();
		let accepting = true;

		const linkedNow = () =>
			[...links.values()].flatMap((l) => (l.alive ? [l.address] : []));

		const linkedHandles = () =>
			new Set([...links.values()].flatMap((l) => (l.alive ? [l.handle] : [])));

		const handlePolicy = (): HandlePolicy => ({
			maxHandles: gmLimits.maxHandles,
			maxKeysPerHandle: gmLimits.maxKeysPerHandle,
			claimDays: gmLimits.claimDays,
			unlinkedDays: gmLimits.unlinkedDays,
			linked: linkedHandles(),
		});

		const fullHandles = (handle: string) =>
			`handle ${handle}: refused: the relay holds its most handles (${gmLimits.maxHandles}), none lapsed`;

		const isOpen = (address: string) => links.get(address)?.alive === true;

		const tablesOf = (handle: string, except?: string) =>
			[...links.values()].filter(
				(l) => l.alive && l.handle === handle && l.address !== except
			).length;

		const index = (link: GmLink) => {
			const named = byTable.get(link.table) ?? new Set<string>();
			named.add(link.address);
			byTable.set(link.table, named);
		};

		const unindex = (link: GmLink) => {
			const named = byTable.get(link.table);
			named?.delete(link.address);

			if (named?.size === 0) {
				byTable.delete(link.table);
			}
		};

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
			wanted: Wanted,
			client: ClientLink,
			made: Exclude<Claim, { readonly full: true }>
		) =>
			Effect.gen(function* () {
				const proven = client.hostKeyFingerprint;
				const { handle, table } = wanted;
				const where = addressText(handle, table);
				const { keys, claimed, dropped } = made;

				for (const old of dropped) {
					yield* Effect.logInfo(
						`handle ${old.handle}: dropped the claim of GM keys ${old.keys.join(", ")}, last seen ${isoTime(old.seen)}${old.handle === handle ? "" : `, to make room for ${handle}`}`
					);
				}

				if (!keys.includes(proven)) {
					return yield* Effect.logWarning(
						`handle ${handle}: refused a GM with key ${proven} from ${address}; it's held by ${keys.join(", ")} (supervillain relay forget ${handle} releases it)`
					);
				}

				if (claimed) {
					yield* Effect.logInfo(
						`handle ${handle}: claimed by GM key ${proven}`
					);
				}

				const link: GmLink = {
					handle,
					table,
					address: where,
					key: proven,
					client,
					alive: true,
					sessions: 0,
					knows: true,
					asking: 0,
				};

				const old = links.get(where);
				links.set(where, link);
				index(link);
				pending.delete(socket);

				const renew = touchHandle(handlesFile, handle, proven).pipe(
					Effect.catchTag("HandlesError", (failure) =>
						Effect.logError(
							`handle ${handle}: can't write the handle registry: ${failure.message}`
						)
					)
				);

				yield* renew;

				yield* Effect.addFinalizer(() =>
					Effect.suspend(() => {
						link.alive = false;

						if (links.get(where) !== link) {
							return renew;
						}

						links.delete(where);
						unindex(link);

						return Effect.andThen(
							renew,
							Effect.logInfo(`table ${where}: GM link closed`)
						);
					})
				);

				if (old === undefined) {
					yield* Effect.logInfo(`table ${where}: GM linked from ${address}`);
				} else {
					old.alive = false;
					old.client.close();
					yield* Effect.logInfo(
						`table ${where}: GM relinked from ${address}; dropped the old link`
					);
				}

				return yield* clientClosed(client);
			});

		const tooManyTables = (handle: string, where: string) =>
			tablesOf(handle, where) >= gmLimits.tablesPerHandle;

		const manyTables = (handle: string) =>
			`handle ${handle}: refused: it has ${gmLimits.tablesPerHandle} tables open already`;

		const runLink = (socket: Socket, address: string, wanted: Wanted) =>
			Effect.gen(function* () {
				const { handle, table, proof } = wanted;
				const where = addressText(handle, table);

				const linkFull = () =>
					!links.has(where) && links.size >= gmLimits.links;

				const fullRefusal = `table ${where}: refused: the relay has its most GMs linked (${gmLimits.links})`;
				let refusal: string | undefined;

				const verdictOf = (offered: string) =>
					Effect.gen(function* () {
						const handles = yield* readHandles(handlesFile);
						const now = yield* Clock.currentTimeMillis;

						return judgeHandle(handles, handle, offered, now, handlePolicy());
					}).pipe(Effect.result);

				const pairingOk = (offered: string, now: number) => {
					if (proof === undefined) {
						return false;
					}

					const checked = pairings.check(proof, handle, offered, address, now);

					if (checked === "slow") {
						refusal = `handle ${handle}: refused: ${addressBucket(address)} tries claim codes too fast`;
					} else if (checked === "bad") {
						refusal = `handle ${handle}: refused a claim from ${address} with key ${offered} that proves no live code it minted for this handle and key`;
					}

					return checked === "ok";
				};

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
							refusal = `handle ${handle}: can't read the handle registry: ${verdict.failure.message}`;

							return false;
						}

						if (linkFull()) {
							refusal = fullRefusal;

							return false;
						}

						if (tooManyTables(handle, where)) {
							refusal = manyTables(handle);

							return false;
						}

						const { success } = verdict;

						if (success.kind === "full") {
							refusal = fullHandles(handle);
						} else if (
							success.kind === "held" &&
							!pairingOk(offered, clock.currentTimeMillisUnsafe())
						) {
							refusal ??= `handle ${handle}: refused a GM with key ${offered} from ${address}; it's held by ${success.keys.join(", ")} (supervillain relay forget ${handle} releases it, or a claim code adds a key)`;
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
									`table ${where}: the GM's host at ${address} refused this relay's key ${relayKey.fingerprint}; the GM pins it with --relay-key or in its relay_known`
								)
							: Effect.logInfo(
									`table ${where}: GM link from ${address} failed: ${failure.message}`
								);
					})
				);

				const proven = client.hostKeyFingerprint;

				const made = yield* claims.withPermits(1)(
					Effect.gen(function* () {
						if (!accepting || client.closed()) {
							return { gone: true } as const;
						}

						if (linkFull()) {
							return { linkFull: true } as const;
						}

						if (tooManyTables(handle, where)) {
							return { manyTables: true } as const;
						}

						const now = yield* Clock.currentTimeMillis;

						const verdict = judgeHandle(
							yield* readHandles(handlesFile),
							handle,
							proven,
							now,
							handlePolicy()
						);

						if (verdict.kind === "held") {
							const code =
								proof === undefined
									? undefined
									: pairings.find(proof, handle, proven, now);

							if (code === undefined) {
								return { held: verdict.keys } as const;
							}

							const added = yield* addKey(
								handlesFile,
								handle,
								proven,
								handlePolicy()
							);

							if (added.kind === "full") {
								return { keysFull: true } as const;
							}

							if (added.kind === "added") {
								pairings.spend(code);
							}

							yield* Effect.logInfo(
								`handle ${handle}: added GM key ${proven} with a claim code`
							);

							const paired: Claim = {
								keys: added.kind === "unclaimed" ? [] : added.keys,
								claimed: false,
								dropped: [],
							};

							return paired;
						}

						const over =
							verdict.kind === "free"
								? claimRate.over(address, now)
								: undefined;

						if (over !== undefined) {
							return { tooFast: over } as const;
						}

						const taken = yield* claimHandle(
							handlesFile,
							handle,
							proven,
							handlePolicy()
						);

						if ("claimed" in taken && taken.claimed) {
							claimRate.spend(address, now);
						}

						return taken;
					})
				);

				if ("gone" in made) {
					return yield* Effect.void;
				}

				if ("linkFull" in made) {
					return yield* Effect.logWarning(fullRefusal);
				}

				if ("manyTables" in made) {
					return yield* Effect.logWarning(manyTables(handle));
				}

				if ("held" in made) {
					return yield* Effect.logWarning(
						`handle ${handle}: refused a GM with key ${proven} from ${address}; it's held by ${made.held.join(", ")}`
					);
				}

				if ("keysFull" in made) {
					return yield* Effect.logWarning(
						`handle ${handle}: refused key ${proven}: it holds its most keys (${gmLimits.maxKeysPerHandle})`
					);
				}

				if ("tooFast" in made) {
					return yield* Effect.logWarning(
						`handle ${handle}: refused: ${made.tooFast} claims handles too fast`
					);
				}

				if ("full" in made) {
					return yield* Effect.logWarning(fullHandles(handle));
				}

				return yield* hold(socket, address, wanted, client, made);
			}).pipe(
				Effect.scoped,
				Effect.catchTags({
					HandlesError: (failure) =>
						Effect.logError(
							`handle ${wanted.handle}: can't read or write the handle registry: ${failure.message}`
						),
					SshError: () => Effect.void,
				}),
				Effect.ensuring(
					Effect.sync(() => {
						socket.destroy();
					})
				)
			);

		const judgeHello = (wanted: Wanted, address: string) =>
			claims.withPermits(1)(
				Effect.gen(function* () {
					const { handle, table } = wanted;
					const where = addressText(handle, table);

					if (!links.has(where) && links.size >= gmLimits.links) {
						return Option.some<Refused>({
							journal: `table ${where}: refused: the relay has its most GMs linked (${gmLimits.links})`,
							reason: "the relay has its most GMs linked; try again later",
						});
					}

					if (tooManyTables(handle, where)) {
						return Option.some<Refused>({
							journal: manyTables(handle),
							reason: `the handle ${handle} has ${gmLimits.tablesPerHandle} tables open already`,
						});
					}

					const now = yield* Clock.currentTimeMillis;

					const verdict = judgeHandle(
						yield* readHandles(handlesFile),
						handle,
						"",
						now,
						handlePolicy()
					);

					if (verdict.kind === "full") {
						return Option.some<Refused>({
							journal: fullHandles(handle),
							reason: "the relay holds its most handles; try again later",
						});
					}

					const over =
						verdict.kind === "free" ? claimRate.over(address, now) : undefined;

					return over === undefined
						? Option.none<Refused>()
						: Option.some<Refused>({
								journal: `handle ${handle}: refused: ${over} claims handles too fast`,
								reason: "this address claims handles too fast; try again later",
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

			const wanted: Wanted =
				hello.proof === undefined
					? { handle: hello.handle, table: hello.table }
					: { handle: hello.handle, table: hello.table, proof: hello.proof };

			return judgeHello(wanted, address).pipe(
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

								return runLink(socket, address, wanted);
							}),
					})
				),
				Effect.catchTag("HandlesError", (failure) =>
					Effect.andThen(
						Effect.logError(
							`handle ${hello.handle}: can't read the handle registry: ${failure.message}`
						),
						Effect.sync(() => {
							refuse(errLine("the relay can't read its handle registry"));
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
								`table ${link.address}: its host doesn't answer the lobby (older)`
							);
						}

						link.knows = false;
					}

					return Option.none<LobbyTable>();
				}

				const channel = opened.success;
				channel.stderr.resume();
				channel.stream.end(
					knowsQueryLine(actor, yield* random.randomBytes(KNOWS_NONCE_BYTES))
				);

				const answer = parseKnowsAnswer(yield* answerOf(channel));

				return answer.known
					? Option.some<LobbyTable>({
							handle: link.handle,
							table: link.table,
							seated: answer.seated,
						})
					: Option.none<LobbyTable>();
			}).pipe(Effect.scoped);

		const tablesFor = (
			actor: string,
			among: ReadonlyArray<GmLink> = [...links.values()]
		) =>
			Effect.gen(function* () {
				const asked = among.filter((l) => l.alive);
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

				return found.toSorted((a, b) =>
					lobbyAddress(a) < lobbyAddress(b) ? -1 : 1
				);
			});

		const claimedHandle = (handle: string) =>
			isHandle(handle)
				? readHandles(handlesFile).pipe(
						Effect.map((handles) => handles[handle] !== undefined),
						Effect.catchTag("HandlesError", (failure) =>
							Effect.as(
								Effect.logError(
									`can't read the handle registry: ${failure.message}`
								),
								true
							)
						)
					)
				: Effect.succeed(false);

		const turnedDown = (handle: string, table: string) =>
			Effect.map(claimedHandle(handle), (held) =>
				held
					? closedTableMessage(addressText(handle, table))
					: `There's no table called ${addressText(handle, table)} here.`
			);

		const heldBy = (fingerprint: string) =>
			readHandles(handlesFile).pipe(
				Effect.map(
					(handles) =>
						Object.entries(handles).find(([, claim]) =>
							claim.keys.includes(fingerprint)
						)?.[0]
				),
				Effect.catchTag("HandlesError", (failure) =>
					Effect.as(
						Effect.logError(
							`can't read the handle registry: ${failure.message}`
						),
						undefined
					)
				)
			);

		const claimInLobby = (
			handle: string,
			fingerprint: string,
			address: string
		): Effect.Effect<Claimed, never, RelayContext> =>
			claims
				.withPermits(1)(
					Effect.gen(function* () {
						const problem = handleProblem(handle);

						if (problem !== undefined) {
							return lobbyRefused(problem);
						}

						const now = yield* Clock.currentTimeMillis;
						const handles = yield* readHandles(handlesFile);

						const verdict = judgeHandle(
							handles,
							handle,
							fingerprint,
							now,
							handlePolicy()
						);

						if (verdict.kind === "holds") {
							const holds: Claimed = { kind: "held", handle };

							return holds;
						}

						if (verdict.kind === "held") {
							return belongsElsewhere(handle);
						}

						if (verdict.kind === "full") {
							return lobbyRefused(
								"The relay holds its most handles right now; try again later."
							);
						}

						if (claimRate.over(address, now) !== undefined) {
							return lobbyRefused(
								"Your address has claimed handles too fast; try again later."
							);
						}

						const taken = yield* claimHandle(
							handlesFile,
							handle,
							fingerprint,
							handlePolicy()
						);

						if ("full" in taken) {
							return lobbyRefused(
								"The relay holds its most handles right now; try again later."
							);
						}

						if (taken.claimed) {
							claimRate.spend(address, now);
							yield* Effect.logInfo(
								`handle ${handle}: claimed in the lobby by key ${fingerprint} from ${address}`
							);
						}

						const mine: Claimed = { kind: "held", handle };

						return taken.keys.includes(fingerprint)
							? mine
							: belongsElsewhere(handle);
					})
				)
				.pipe(
					Effect.catchTag("HandlesError", (failure) =>
						Effect.as(
							Effect.logError(
								`handle ${handle}: can't read or write the handle registry: ${failure.message}`
							),
							lobbyRefused(
								"The relay can't save handles right now; try again later."
							)
						)
					)
				);

		const mintInLobby = (
			handle: string,
			fingerprint: string
		): Effect.Effect<Paired, never, RelayContext> =>
			mintPairing(handle, fingerprint).pipe(
				Effect.map((minted): Paired => minted),
				Effect.catchTag("HandlesError", (failure) =>
					Effect.as(
						Effect.logError(
							`handle ${handle}: can't read the handle registry: ${failure.message}`
						),
						{
							kind: "refused",
							reason:
								"The relay can't make a pairing code right now; try again later.",
						} satisfies Paired
					)
				)
			);

		const sandboxNote: SandboxNote = {
			open: sandboxes.live > 0,
			cols: sandboxes.minCols,
			rows: sandboxes.minRows,
			idleMinutes: minutesOf(sandboxes.idleMs),
			maxMinutes: minutesOf(sandboxes.maxMs),
		};

		const lobby = (
			session: RawSession,
			opening: Opening,
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

				const tables =
					opening.only ?? (knowsMe(session) ? yield* tablesFor(actor) : []);

				yield* Effect.logDebug(
					`lobby: ${actor} from ${info.remoteAddress}: ${tables.length} open tables know the key`
				);

				if (!terminal) {
					if (opening.said !== undefined) {
						return turnAway(1, opening.said);
					}

					return turnAway(
						1,
						tables.length === 0 ? JOIN_HINT : lobbyText(tables)
					);
				}

				const fingerprint = id.kind === "key" ? id.fingerprint : undefined;

				const you = {
					key:
						id.kind === "key"
							? { fingerprint: id.fingerprint, algorithm: id.algorithm }
							: undefined,
					term: info.term,
				};

				const held =
					fingerprint === undefined ? undefined : yield* heldBy(fingerprint);

				const state = lobbying(
					createForm(fingerprint === undefined, held, options.publicRelay),
					{ picked: 0, said: opening.said }
				);

				const listed = tables.map(lobbyAddress);
				let drawn = "";

				const draw = (now: Lobbying) => {
					const frame = lobbyFrame(
						{
							tab: now.tab,
							editing: now.editing,
							create: now.create,
							sandbox: sandboxNote,
							tables,
							picked: now.picked,
							typed: now.typed,
							said: now.said,
							you,
						},
						sizing.size.cols,
						sizing.size.rows
					);

					if (frame !== drawn) {
						drawn = frame;
						session.stream.write(frame);
					}
				};

				const leaving = (code: number, text?: string) => {
					session.stream.write(CLEAR);
					const kept = keptCommands(state);

					if (kept !== undefined) {
						say(kept);
					}

					return turnAway(code, text);
				};

				const named = (name: string) =>
					Effect.gen(function* () {
						const wanted = parseAddress(name);

						if (wanted.kind === "table") {
							const where = addressText(wanted.handle, wanted.table);

							return isOpen(where)
								? Result.succeed(where)
								: Result.fail(yield* turnedDown(wanted.handle, wanted.table));
						}

						if (wanted.kind === "short") {
							const matches = tables.filter((t) => t.table === wanted.table);
							const [only] = matches;

							if (matches.length === 1 && only !== undefined) {
								return Result.succeed(lobbyAddress(only));
							}

							return Result.fail(
								matches.length === 0
									? shorthandMessage(wanted.table)
									: manyMessage(wanted.table)
							);
						}

						return Result.fail(`"${name}" isn't a table's name. ${JOIN_HINT}`);
					});

				const answered = (asked: CreateAsk) =>
					Effect.gen(function* () {
						if (fingerprint === undefined) {
							return;
						}

						if (asked.kind === "claim") {
							const outcome = yield* claimInLobby(
								asked.handle,
								fingerprint,
								info.remoteAddress
							);

							state.create = afterClaim(state.create, outcome);

							if (outcome.kind === "held") {
								state.editing = true;
							}

							return;
						}

						const outcome = yield* mintInLobby(asked.handle, fingerprint);
						state.create = afterPairing(state.create, outcome);
						const { ready } = state.create;

						if (outcome.kind === "minted" && ready !== undefined) {
							state.editing = false;
							yield* Effect.logInfo(
								`handle ${asked.handle}: ${actor} made a pairing code in the lobby`
							);
							session.stream.write(
								osc52(
									commandsText(commandsOf(state.create, ready)),
									info.term,
									info.env
								)
							);
						}
					});

				const copied = (what: "commands" | "fingerprint") => {
					if (what === "commands") {
						const { ready } = state.create;

						if (ready === undefined) {
							return;
						}

						session.stream.write(
							osc52(
								commandsText(commandsOf(state.create, ready)),
								info.term,
								info.env
							)
						);
						state.create = {
							...state.create,
							said: "Copied commands to clipboard.",
						};

						return;
					}

					if (fingerprint === undefined) {
						return;
					}

					session.stream.write(osc52(fingerprint, info.term, info.env));
					state.said = "Copied fingerprint to clipboard.";
				};

				const tried = Effect.gen(function* () {
					const problem = sizeProblem(
						sizing.size.cols,
						sizing.size.rows,
						sandboxes
					);

					if (problem !== undefined) {
						state.said = problem;

						return false;
					}

					const admitted = gate.admit(info.remoteAddress, fingerprint);

					if (admitted.kind === "out") {
						state.said = admitted.reason;

						return false;
					}

					session.stream.write(CLEAR);
					yield* runSandbox(session, sandboxes).pipe(
						Effect.ensuring(Effect.sync(admitted.release))
					);

					return true;
				});

				let misses = 0;

				while (misses < LOBBY_TRIES) {
					const picked = yield* readLobby(
						session,
						listed,
						lobbyIdleMs,
						state,
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
						return leaving(0);
					}

					if (picked.kind === "idle") {
						return leaving(1, "No table picked; come back any time.");
					}

					if (picked.kind === "try") {
						if (yield* tried) {
							return turnAway(0);
						}

						continue;
					}

					if (picked.kind === "ask") {
						yield* answered(picked.ask);

						continue;
					}

					if (picked.kind === "copy") {
						copied(picked.what);

						continue;
					}

					const chosen =
						picked.kind === "listed"
							? Result.succeed(picked.room)
							: yield* named(picked.name);

					if (Result.isSuccess(chosen)) {
						session.stream.write(CLEAR);
						say(`Joining ${chosen.success}…`);

						return Option.some(chosen.success);
					}

					yield* Effect.logDebug(
						`lobby: ${actor} from ${info.remoteAddress} asked for ${picked.kind === "named" ? picked.name : picked.room}, which isn't open`
					);
					misses += 1;

					if (picked.kind === "listed") {
						state.picked = 0;
					}

					state.typed = "";
					state.said = chosen.failure;
				}

				return leaving(1, JOIN_HINT);
			});

		const seatIn = (
			session: RawSession,
			where: string,
			invite: string | undefined,
			terminal: boolean,
			say: (text: string) => void,
			sizing: Sizing
		) =>
			Effect.gen(function* () {
				const { info } = session;
				const { actor } = info.identity;
				const link = links.get(where);

				if (link?.alive !== true) {
					say(closedTableMessage(where));
					session.exit(1);

					return;
				}

				if (!isRelayableActor(actor)) {
					say("The relay can't seat you.");
					session.exit(1);

					return;
				}

				if (link.sessions >= sessionsPerTable) {
					yield* Effect.logInfo(
						`table ${where}: full (${sessionsPerTable} sessions); turned ${actor} away`
					);
					say(fullTableMessage(where));
					session.exit(1);

					return;
				}

				link.sessions += 1;

				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						link.sessions -= 1;
					})
				);

				const env: Record<string, string> = Object.fromEntries(
					Object.entries(info.env).filter(
						([key]) =>
							key !== RELAYED_ACTOR_ENV &&
							key !== RELAYED_CLIENT_ENV &&
							key !== RELAYED_INVITE_ENV &&
							key !== RELAYED_BUCKET_ENV
					)
				);

				env[RELAYED_ACTOR_ENV] = actor;
				env[RELAYED_CLIENT_ENV] = info.client;
				env[RELAYED_BUCKET_ENV] = bucketOf(info.remoteAddress);

				if (invite !== undefined) {
					env[RELAYED_INVITE_ENV] = invite;
				}

				const openedAt = sizing.size;

				const channel = yield* Effect.result(
					seat(link, session, env, openedAt)
				);

				if (Result.isFailure(channel)) {
					const why = channel.failure.message;
					yield* unseated(where, actor, why);

					const tooOld =
						session.request.kind === "subsystem" &&
						why.startsWith("Unable to start subsystem");

					const unopened = link.alive
						? "The table couldn't seat you right now."
						: TABLE_CLOSED_MESSAGE;

					say(tooOld ? AGENTS_TOO_OLD : unopened);
					session.exit(1);

					return;
				}

				const opened = channel.success;

				yield* Effect.logDebug(
					`table ${where}: seated ${actor} from ${info.remoteAddress}`
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

		const shorthand = (session: RawSession, table: string) =>
			Effect.gen(function* () {
				const candidates = [...links.values()].filter(
					(l) => l.alive && (l.table === table || l.handle === table)
				);

				if (candidates.length === 0) {
					return { kind: "lobby", opening: {} } as const;
				}

				const known = knowsMe(session)
					? yield* tablesFor(session.info.identity.actor, candidates)
					: [];

				const [only] = known;

				if (known.length === 1 && only !== undefined) {
					return {
						kind: "seat",
						where: lobbyAddress(only),
						shorthand: true,
					} as const;
				}

				const opening: Opening =
					known.length === 0 ? {} : { said: manyMessage(table), only: known };

				return { kind: "lobby", opening } as const;
			});

		const route = (session: RawSession) =>
			Effect.gen(function* () {
				const wanted = parseAddress(session.info.user);

				if (wanted.kind === "table") {
					const where = addressText(wanted.handle, wanted.table);

					return isOpen(where)
						? ({ kind: "seat", where, shorthand: false } as const)
						: ({
								kind: "lobby",
								opening: { said: closedTableMessage(where) },
							} as const);
				}

				if (wanted.kind === "short" && !isReservedShortTable(wanted.table)) {
					return yield* shorthand(session, wanted.table);
				}

				return { kind: "lobby", opening: {} } as const;
			});

		const agentRoute = (
			session: RawSession,
			invite: string | undefined,
			say: (text: string) => void,
			sizing: Sizing
		) =>
			Effect.gen(function* () {
				const routed = yield* route(session);

				if (routed.kind === "seat") {
					yield* seatIn(session, routed.where, invite, false, say, sizing);

					return;
				}

				const wanted = parseAddress(session.info.user);

				say(
					routed.opening.said ??
						(wanted.kind === "short"
							? shorthandMessage(wanted.table)
							: JOIN_HINT)
				);
				session.exit(1);
			});

		const bridge = (session: RawSession) =>
			Effect.gen(function* () {
				const { info } = session;
				const terminal = session.request.kind === "shell" && session.pty;
				const { invite } = parseAddress(info.user);

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

				if (session.request.kind === "subsystem") {
					yield* agentRoute(session, invite, say, sizing);

					return;
				}

				const routed = yield* route(session);

				if (routed.kind === "seat" && routed.shorthand) {
					say(`Joining ${routed.where}…`);
				}

				const where =
					routed.kind === "seat"
						? Option.some(routed.where)
						: yield* lobby(session, routed.opening, terminal, say, sizing);

				if (Option.isSome(where)) {
					yield* seatIn(session, where.value, invite, terminal, say, sizing);
				}
			});

		const mintPairing = Effect.fn("Relay.mintPairing")(function* (
			handle: string,
			by: string
		) {
			const now = yield* Clock.currentTimeMillis;
			const handles = yield* readHandles(handlesFile);

			if (handles[handle]?.keys.includes(by) !== true) {
				const refused: Minted = {
					kind: "refused",
					reason: `the key ${by} doesn't hold the handle ${handle}`,
				};

				return refused;
			}

			const bytes = yield* random.randomBytes(PAIRING_BYTES);

			return pairings.mint(handle, by, bytes, now);
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
			subsystems: {
				[MCP_SUBSYSTEM]: (session) =>
					bridge(session).pipe(Effect.provideContext(services)),
			},
		});

		const info: RelayInfo = {
			playerPort: players.port,
			gmPort,
			hostKeyFingerprint: players.hostKeyFingerprint,
			relayKeyFingerprint: relayKey.fingerprint,
			linkedTables: linkedNow,
			sandboxesLive: gate.live,
			mintPairing: (handle, by) =>
				mintPairing(handle, by).pipe(Effect.provideContext(services)),
			claimHandle: (handle, fingerprint) =>
				claims
					.withPermits(1)(
						claimHandle(handlesFile, handle, fingerprint, handlePolicy())
					)
					.pipe(Effect.provideContext(services)),
		};

		return info;
	});

export class Relay extends Context.Service<Relay, RelayInfo>()(
	"supervillain/relay/Relay"
) {
	static readonly make = make;

	static readonly layer = (
		options: RelayOptions
	): Layer.Layer<
		Relay,
		RelayError | HandlesError | SshError,
		RelayContext | SecureRandom.SecureRandom
	> => Layer.effect(Relay, Relay.make(options));
}
