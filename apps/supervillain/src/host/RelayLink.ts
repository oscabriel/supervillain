import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { isFingerprint, messageOf } from "@supervillain/ssh";
import type { AttachOptions } from "@supervillain/ssh";
import {
	Clock,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Latch,
	Layer,
	Match,
	Option,
	Path,
	Schedule,
	Schema,
	SubscriptionRef,
} from "effect";
import type { Types } from "effect";

import {
	addressText,
	DEFAULT_RELAY_PLAYER_PORT,
	claimProof,
	helloLine,
	parseRelayAddress,
	MAX_LINE_BYTES,
	parseAnswer,
} from "../relay/protocol.ts";
import type { Answer } from "../relay/protocol.ts";
import type { View } from "./View.ts";

export { parseRelayAddress };

const RELAY_KNOWN_FILE = "relay_known";

export const RelayStatus = Schema.Union([
	Schema.Struct({
		state: Schema.Literal("connecting"),
		lastError: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		state: Schema.Literal("connected"),
		relayKey: Schema.String,
		firstUse: Schema.Boolean,
	}),
	Schema.Struct({
		state: Schema.Literal("refused"),
		reason: Schema.String,
		retrying: Schema.Boolean,
	}),
]);

export type RelayStatus = typeof RelayStatus.Type;

const sameStatus = Schema.toEquivalence(RelayStatus);

export interface RelayLinkOptions {
	readonly host: string;
	readonly port: number;
	readonly handle: string;
	readonly table: string;
	readonly claim?: string;
	readonly hostKey?: Buffer;
	readonly hostKeyFingerprint: string;
	readonly playerPort?: number;
	readonly campaignDir: string;
	readonly knownPath?: string;
	readonly relayKey?: string;
	readonly attach: (socket: Socket, options: AttachOptions) => void;
	readonly timeouts?: {
		readonly connectMs?: number;
		readonly replyMs?: number;
	};
}

export interface RelayLinkService {
	readonly status: View<RelayStatus>;
	readonly joinCommand: string;
}

export class RelayLinkError extends Schema.TaggedError<RelayLinkError>()(
	"RelayLinkError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

const FIRST_DELAY = Duration.seconds(1);

const MAX_DELAY = Duration.seconds(30);

const FIX_POLL = "5 seconds";

const DEFAULT_CONNECT_MS = 10_000;

const DEFAULT_REPLY_MS = 10_000;

const NOT_SLUG = /[^a-z0-9]+/gu;

const LEADING_NON_LETTERS = /^[^a-z]+/u;

const TRAILING_HYPHENS = /-+$/u;

const SPACES = /\s+/u;

export const backoff = Schedule.exponential(FIRST_DELAY).pipe(
	Schedule.modifyDelay(({ duration }) =>
		Effect.succeed(Duration.min(duration, MAX_DELAY))
	),
	Schedule.jittered
);

export const redialDelay = Effect.fn("RelayLink.redialDelay")(function* (
	attempt: number
) {
	const step = yield* Schedule.toStep(backoff);
	let delay = FIRST_DELAY;

	for (const _n of Array.from({ length: attempt + 1 })) {
		const [, next] = yield* step(0, undefined);
		delay = next;
	}

	return Duration.millis(Math.round(Duration.toMillis(delay)));
});

export const roomSlug = (name: string): string => {
	const slug = name
		.toLowerCase()
		.replaceAll(NOT_SLUG, "-")
		.replace(LEADING_NON_LETTERS, "")
		.slice(0, 32)
		.replace(TRAILING_HYPHENS, "");

	return slug === "" ? "table" : slug;
};

export const relayJoinCommand = (
	name: string,
	host: string,
	playerPort: number = DEFAULT_RELAY_PLAYER_PORT
): string =>
	`ssh ${playerPort === 22 ? "" : `-p ${playerPort} `}${name}@${host}`;

export const joinNote = (status: RelayStatus, joinCommand: string): string =>
	Match.value(status).pipe(
		Match.discriminatorsExhaustive("state")({
			connected: (connected) =>
				connected.firstUse
					? `players join with: ${joinCommand} · relay key ${connected.relayKey} trusted on first use`
					: `players join with: ${joinCommand}`,
			connecting: (connecting) =>
				connecting.lastError === undefined
					? "relay: connecting…"
					: `relay: connecting… (${connecting.lastError})`,
			refused: (refused) => `relay refused: ${refused.reason}`,
		})
	);

export const linkAlert = (status: RelayStatus): string | undefined =>
	Match.value(status).pipe(
		Match.discriminatorsExhaustive("state")({
			connected: (): string | undefined => undefined,
			connecting: (connecting) =>
				connecting.lastError === undefined
					? "relay: connecting…"
					: "relay: down, redialing",
			refused: (refused) =>
				refused.retrying
					? "relay: refused, redialing"
					: "relay: refused, see host.log",
		})
	);

type Outcome = Data.TaggedEnum<{
	dropped: { readonly held: boolean };
	failed: { readonly error: string };
	answered: { readonly reason: string };
	keyRefused: {
		readonly reason: string;
		readonly final: boolean;
		readonly refusedOn: string | undefined;
	};
}>;

const Outcome = Data.taggedEnum<Outcome>();

type Pin = "required" | "best-effort" | "none";

interface Admitted {
	readonly admit: true;
	readonly firstUse: boolean;
	readonly pin: Pin;
}

interface Refused {
	readonly admit: false;
	readonly reason: string;
	readonly final: boolean;
}

type Decision = Admitted | Refused;

type Known =
	| { readonly kind: "given"; readonly key: string }
	| { readonly kind: "absent" }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "unreadable"; readonly message: string };

type Next = "redial" | "reset" | "now";

const pinnedIn = (text: string): ReadonlyArray<string> =>
	text
		.split("\n")
		.map((line) => line.trim().split(SPACES)[0] ?? "")
		.filter((token) => token !== "" && !token.startsWith("#"));

const snapshotOf = (known: Known): string | undefined =>
	Match.value(known).pipe(
		Match.discriminators("kind")({
			text: (text) => text.text,
			unreadable: (unreadable) => `unreadable: ${unreadable.message}`,
		}),
		Match.option,
		Option.getOrUndefined
	);

const pinSync = (
	knownPath: string,
	fingerprint: string
): string | undefined => {
	try {
		writeFileSync(knownPath, `${fingerprint}\n`, {
			flag: "wx",
			mode: 0o600,
		});

		return undefined;
	} catch (error) {
		return messageOf(error);
	}
};

const decidePinned = (
	text: string,
	knownPath: string,
	fingerprint: string
): Decision => {
	const pinned = pinnedIn(text);

	if (pinned.length === 0 || !pinned.every(isFingerprint)) {
		return {
			admit: false,
			final: true,
			reason: `${knownPath} must hold relay key fingerprints (SHA256:…), one a line`,
		};
	}

	return pinned.includes(fingerprint)
		? { admit: true, firstUse: false, pin: "none" }
		: {
				admit: false,
				final: true,
				reason: `its key ${fingerprint} doesn't match ${pinned.join(" or ")} in ${knownPath}; if the relay's key really changed, put the new one there`,
			};
};

const decide = (
	known: Known,
	knownPath: string,
	fingerprint: string
): Decision =>
	Match.value(known).pipe(
		Match.discriminatorsExhaustive("kind")({
			given: (given): Decision =>
				fingerprint === given.key
					? { admit: true, firstUse: false, pin: "best-effort" }
					: {
							admit: false,
							final: true,
							reason: `its key ${fingerprint} doesn't match --relay-key ${given.key}`,
						},
			unreadable: (unreadable): Decision => ({
				admit: false,
				final: true,
				reason: `can't read ${knownPath}: ${unreadable.message}`,
			}),
			absent: (): Decision => ({
				admit: true,
				firstUse: true,
				pin: "required",
			}),
			text: (text) => decidePinned(text.text, knownPath, fingerprint),
		})
	);

const closedSignal = (socket: Socket) =>
	Effect.gen(function* () {
		const closed = yield* Latch.make();
		socket.once("close", () => {
			closed.openUnsafe();
		});

		return closed;
	});

const awaitConnect = (
	socket: Socket,
	lastError: () => string | undefined
): Effect.Effect<void, RelayLinkError> =>
	Effect.callback((resume) => {
		if (!socket.connecting && !socket.destroyed) {
			resume(Effect.void);

			return Effect.void;
		}

		const onConnect = () => {
			resume(Effect.void);
		};

		const onClose = () => {
			resume(
				Effect.fail(
					new RelayLinkError({
						message: lastError() ?? "the connection closed",
					})
				)
			);
		};

		socket.once("connect", onConnect);
		socket.once("close", onClose);

		return Effect.sync(() => {
			socket.removeListener("connect", onConnect);
			socket.removeListener("close", onClose);
		});
	});

const readReply = (socket: Socket): Effect.Effect<Answer, RelayLinkError> =>
	Effect.callback((resume) => {
		let buffer = Buffer.alloc(0);

		const fail = (message: string) => {
			resume(Effect.fail(new RelayLinkError({ message })));
		};

		const stop = () => {
			socket.removeListener("data", onData);
			socket.removeListener("close", onClose);
		};

		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf(0x0a);

			if (end === -1 && buffer.length < MAX_LINE_BYTES) {
				return;
			}

			socket.pause();
			stop();

			if (end === -1 || end + 1 > MAX_LINE_BYTES) {
				fail("the relay's answer was too long");

				return;
			}

			const rest = buffer.subarray(end + 1);

			if (rest.length > 0) {
				socket.unshift(rest);
			}

			resume(
				Effect.succeed(parseAnswer(buffer.subarray(0, end).toString("utf-8")))
			);
		};

		const onClose = () => {
			stop();
			fail("the relay closed the link before answering");
		};

		socket.on("data", onData);
		socket.once("close", onClose);

		return Effect.sync(stop);
	});

export class RelayLink extends Context.Service<RelayLink, RelayLinkService>()(
	"supervillain/host/RelayLink"
) {
	static readonly make = Effect.fn("RelayLink.make")(function* (
		options: RelayLinkOptions
	) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = `${options.host}:${options.port}`;

		const knownPath =
			options.knownPath ?? path.join(options.campaignDir, RELAY_KNOWN_FILE);

		const named = addressText(options.handle, options.table);

		const proof =
			options.claim === undefined
				? undefined
				: claimProof(options.claim, options.hostKeyFingerprint);

		const connectMs = options.timeouts?.connectMs ?? DEFAULT_CONNECT_MS;
		const replyMs = options.timeouts?.replyMs ?? DEFAULT_REPLY_MS;

		const status = yield* SubscriptionRef.make<RelayStatus>({
			state: "connecting",
		});

		const announce = (next: RelayStatus): Effect.Effect<void> =>
			Match.value(next).pipe(
				Match.discriminatorsExhaustive("state")({
					connecting: (connecting) =>
						connecting.lastError === undefined
							? Effect.logInfo(`relay ${where}: connecting`)
							: Effect.logWarning(
									`relay ${where}: connecting (${connecting.lastError})`
								),
					connected: (connected) =>
						Effect.logInfo(
							`relay ${where}: linked as ${named}, relay key ${connected.relayKey}`
						).pipe(
							Effect.andThen(
								connected.firstUse
									? Effect.logWarning(
											`relay ${where}: trusted relay key ${connected.relayKey} on first use; pinned in ${knownPath}`
										)
									: Effect.void
							)
						),
					refused: (refused) =>
						refused.retrying
							? Effect.logWarning(
									`relay ${where} refused the link: ${refused.reason}`
								)
							: Effect.logError(
									`relay ${where}: refused the relay: ${refused.reason}. Not redialing until that's fixed.`
								),
				})
			);

		const setStatus = Effect.fn("RelayLink.setStatus")(function* (
			next: RelayStatus
		) {
			const previous = yield* SubscriptionRef.getAndSet(status, next);

			if (!sameStatus(previous, next)) {
				yield* announce(next);
			}
		});

		const readKnown = fs.readFileString(knownPath).pipe(
			Effect.asSome,
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(Option.none<string>())
			)
		);

		const known: Effect.Effect<Known> =
			options.relayKey === undefined
				? readKnown.pipe(
						Effect.map(
							Option.match({
								onNone: (): Known => ({ kind: "absent" }),
								onSome: (text): Known => ({ kind: "text", text }),
							})
						),
						Effect.catchTag("PlatformError", (cause) =>
							Effect.succeed<Known>({
								kind: "unreadable",
								message: cause.message,
							})
						)
					)
				: Effect.succeed({ kind: "given", key: options.relayKey });

		const linkOnce = Effect.fn("RelayLink.linkOnce")(function* () {
			const trusted = yield* known;
			const refusedOn = snapshotOf(trusted);
			let lastError: string | undefined;
			let attached = false;

			const socket = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const dialed = connect({ host: options.host, port: options.port });
					dialed.on("error", (error: Error) => {
						lastError = error.message;
					});

					return dialed;
				}),
				(dialed) =>
					Effect.sync(() => {
						if (!attached) {
							dialed.destroy();
						}
					})
			);

			const closed = yield* closedSignal(socket);

			yield* awaitConnect(socket, () => lastError).pipe(
				Effect.timeoutOrElse({
					duration: connectMs,
					orElse: () =>
						Effect.fail(
							new RelayLinkError({ message: `no answer from ${where}` })
						),
				}),
				Effect.mapError(
					(cause) =>
						new RelayLinkError({
							message: `can't reach ${where}: ${cause.message}`,
							cause,
						})
				)
			);

			socket.setNoDelay(true);
			socket.write(helloLine(options.handle, options.table, proof));

			const reply = yield* readReply(socket).pipe(
				Effect.timeoutOrElse({
					duration: replyMs,
					orElse: () =>
						Effect.fail(
							new RelayLinkError({
								message: "the relay didn't answer the hello",
							})
						),
				})
			);

			if (!reply.ok) {
				return Outcome.answered({ reason: reply.reason });
			}

			const admitted = yield* Deferred.make<{
				readonly relayKey: string;
				readonly decision: Admitted;
			}>();

			const refusal = yield* Deferred.make<Refused>();
			attached = true;

			const attachOptions: Types.Mutable<AttachOptions> = {
				persistent: true,
				admitRelay: (fingerprint) => {
					const decision = decide(trusted, knownPath, fingerprint);

					if (decision.admit) {
						if (decision.pin !== "none") {
							const pinError = pinSync(knownPath, fingerprint);

							if (pinError !== undefined && decision.pin === "required") {
								Deferred.doneUnsafe(
									refusal,
									Exit.succeed({
										admit: false,
										final: false,
										reason: `can't pin its key in ${knownPath}: ${pinError}`,
									})
								);
								setImmediate(() => {
									socket.destroy();
								});

								return false;
							}
						}

						Deferred.doneUnsafe(
							admitted,
							Exit.succeed({ relayKey: fingerprint, decision })
						);

						return true;
					}

					Deferred.doneUnsafe(refusal, Exit.succeed(decision));
					setImmediate(() => {
						socket.destroy();
					});

					return false;
				},
			};

			if (options.hostKey !== undefined) {
				attachOptions.hostKey = options.hostKey;
			}

			options.attach(socket, attachOptions);

			const up = yield* Effect.raceFirst(
				Deferred.await(admitted).pipe(Effect.asSome),
				closed.await.pipe(Effect.as(Option.none()))
			);

			if (Option.isNone(up)) {
				const refused = yield* Deferred.poll(refusal);

				if (Option.isSome(refused)) {
					const decision = yield* refused.value;

					return Outcome.keyRefused({
						reason: decision.reason,
						final: decision.final,
						refusedOn,
					});
				}

				return Outcome.failed({
					error: `the link closed before the relay logged in; if this keeps up, another GM's key may hold the handle ${options.handle} there (a claim code from a machine that holds it adds this one)`,
				});
			}

			const { relayKey, decision } = up.value;

			yield* setStatus({
				state: "connected",
				relayKey,
				firstUse: decision.firstUse,
			});

			const since = yield* Clock.currentTimeMillis;
			yield* closed.await;
			const now = yield* Clock.currentTimeMillis;

			return Outcome.dropped({
				held: now - since >= Duration.toMillis(FIRST_DELAY),
			});
		}, Effect.scoped);

		const snapshot = readKnown.pipe(
			Effect.map(Option.getOrUndefined),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed(`unreadable: ${cause.message}`)
			)
		);

		const watchForFix = Effect.fn("RelayLink.watchForFix")(function* (
			refusedOn: string | undefined
		) {
			const current = yield* snapshot;

			if (current === refusedOn) {
				yield* Effect.sleep(FIX_POLL).pipe(
					Effect.andThen(snapshot),
					Effect.repeat({ until: (now) => now !== refusedOn })
				);
			}

			yield* Effect.logInfo(`relay ${where}: ${knownPath} changed; redialing`);
		});

		const awaitFix = (refusedOn: string | undefined): Effect.Effect<void> =>
			options.relayKey === undefined ? watchForFix(refusedOn) : Effect.never;

		const settle = (outcome: Outcome): Effect.Effect<Next> =>
			Outcome.$match(outcome, {
				dropped: (dropped) =>
					setStatus({
						state: "connecting",
						lastError: dropped.held
							? "the link dropped"
							: "the link dropped within a second of login; if it keeps on, the relay's log says why",
					}).pipe(Effect.as<Next>(dropped.held ? "reset" : "redial")),
				failed: (failed) =>
					setStatus({ state: "connecting", lastError: failed.error }).pipe(
						Effect.as<Next>("redial")
					),
				answered: (answered) =>
					setStatus({
						state: "refused",
						reason: answered.reason,
						retrying: true,
					}).pipe(Effect.as<Next>("redial")),
				keyRefused: (refused) =>
					setStatus({
						state: "refused",
						reason: refused.reason,
						retrying: !refused.final,
					}).pipe(
						Effect.andThen(
							refused.final
								? awaitFix(refused.refusedOn).pipe(
										Effect.andThen(setStatus({ state: "connecting" })),
										Effect.as<Next>("now")
									)
								: Effect.succeed<Next>("redial")
						)
					),
			}).pipe(Effect.withSpan("RelayLink.settle"));

		const attempt: Effect.Effect<Next> = linkOnce().pipe(
			Effect.catchTag("RelayLinkError", (failure) =>
				Effect.succeed(Outcome.failed({ error: failure.message }))
			),
			Effect.flatMap(settle)
		);

		const round = Effect.repeat(attempt, {
			schedule: backoff,
			while: (next) => next === "redial",
		});

		const afterRound = (next: Next) =>
			next === "reset"
				? Effect.flatMap(redialDelay(0), Effect.sleep)
				: Effect.void;

		yield* Effect.forkScoped(Effect.forever(Effect.flatMap(round, afterRound)));

		const service: RelayLinkService = {
			status: {
				get: SubscriptionRef.get(status),
				changes: SubscriptionRef.changes(status),
			},
			joinCommand: relayJoinCommand(named, options.host, options.playerPort),
		};

		return service;
	});

	static readonly layer = (
		options: RelayLinkOptions
	): Layer.Layer<RelayLink, never, FileSystem.FileSystem | Path.Path> =>
		Layer.effect(RelayLink, RelayLink.make(options));
}
