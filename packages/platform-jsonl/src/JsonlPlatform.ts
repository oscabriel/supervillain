import type { SendMeta } from "@alchemy.run/domain/Aggregate";
import { Platform } from "@alchemy.run/domain/Platform";
import type {
	AggregateKit,
	AggregateStore,
	HandleInput,
	Json,
	ModelHost,
	SendResult,
	StoredEvent,
} from "@alchemy.run/domain/Platform";
import {
	Cause,
	Clock,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	PubSub,
	Ref,
	Result,
	Schema,
	Scope,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";

import { CampaignLog, LogError } from "./CampaignLog.ts";
import { batchesOf, decodeBatch, encodeLines, eventOf } from "./codec.ts";
import type { Batch, Source } from "./codec.ts";

export class Unsupported extends Schema.TaggedError<Unsupported>()(
	"Unsupported",
	{ message: Schema.String }
) {}

export const Refused = Schema.TaggedStruct("Refused", {
	message: Schema.String,
});

const Rejected = Schema.TaggedStruct("Rejected", {
	rejection: Schema.Unknown,
});

const Accepted = Schema.TaggedStruct("Accepted", {
	receipt: Schema.Struct({
		stream: Schema.String,
		version: Schema.Int,
		events: Schema.Array(Schema.Unknown),
		reply: Schema.Unknown,
	}),
});

export interface JsonlPlatformOptions {
	readonly dir: string;
	readonly tableId: string;
}

export interface MemoryPlatformOptions {
	readonly tableId: string;
	readonly cap: number;
}

export interface Snapshot {
	readonly state: Json;
	readonly version: number;
}

interface Writer {
	readonly last: number;
	readonly halted: Option.Option<string>;
}

interface Seeded {
	readonly seq: number;
	readonly event: Json;
}

interface Prepared {
	readonly commandId: string;
	readonly at: number;
	readonly events: ReadonlyArray<Seeded>;
}

interface Halt {
	readonly seq: number;
	readonly cause: Cause.Cause<never>;
}

const receiptLimit = 1024;

const initial: Snapshot = { state: null, version: 0 };

const refused = (message: string): SendResult =>
	Rejected.make({ rejection: Refused.make({ message }) });

const describe = (cause: Cause.Cause<never>) => {
	const error = Cause.squash(cause);

	return Predicate.hasProperty(error, "message") &&
		Predicate.isString(error.message)
		? error.message
		: Cause.pretty(cause);
};

const remember = (
	receipts: Map<string, SendResult>,
	commandId: string,
	sent: SendResult
) => {
	receipts.delete(commandId);
	receipts.set(commandId, sent);
	const [oldest] = receipts.keys();

	if (receipts.size > receiptLimit && oldest !== undefined) {
		receipts.delete(oldest);
	}
};

const stranger = (tableId: string, id: string) =>
	new Unsupported({
		message: `JsonlPlatform hosts the instance ${tableId}, not ${id}`,
	});

const prepare = Effect.fn("JsonlPlatform.prepare")(function* () {
	const log = yield* CampaignLog;
	const opened = yield* log.lines(0);
	const batches = yield* batchesOf(opened);

	return yield* Effect.forEach(
		batches,
		(batch) =>
			Effect.map(
				Effect.forEach(
					batch.lines,
					(line) =>
						Effect.map(eventOf(line), (event): Seeded => ({
							seq: line.seq,
							event,
						})),
					{ concurrency: 1 }
				),
				(events): Prepared => ({
					commandId: batch.commandId,
					at: batch.at,
					events,
				})
			),
		{ concurrency: 1 }
	);
});

const lastSeq = (batch: Batch) => batch.lines.at(-1)?.seq ?? 0;

const batchesAfter = (
	log: CampaignLog["Service"],
	after: number,
	back: number
): Effect.Effect<ReadonlyArray<Batch>, LogError> =>
	Effect.gen(function* () {
		const floor = Math.max(0, after - back);
		const batches = yield* batchesOf(yield* log.lines(floor));
		const [first] = batches;

		return floor > 0 && first !== undefined && lastSeq(first) > after
			? yield* batchesAfter(log, after, back * 8)
			: batches;
	});

const seedInput = (
	tableId: string,
	snapshot: Snapshot,
	batch: Prepared,
	events: ReadonlyArray<Seeded>
) => ({
	id: tableId,
	state: snapshot.state,
	version: snapshot.version,
	events: events.map((seeded) => seeded.event),
	commandId: batch.commandId,
	now: batch.at,
});

const locate = (
	kit: AggregateKit,
	tableId: string,
	start: Snapshot,
	batch: Prepared
) =>
	Effect.gen(function* () {
		let snapshot = start;

		for (const seeded of batch.events) {
			const exit = yield* Effect.exit(
				kit.seed(seedInput(tableId, snapshot, batch, [seeded]))
			);

			if (Exit.isFailure(exit)) {
				const halt: Halt = { seq: seeded.seq, cause: exit.cause };

				return Option.some(halt);
			}

			snapshot = { state: exit.value.state, version: exit.value.version };
		}

		return Option.none<Halt>();
	});

const replay = (
	kit: AggregateKit,
	tableId: string,
	batches: ReadonlyArray<Prepared>
) =>
	Effect.gen(function* () {
		let snapshot = initial;
		let last = Number.NEGATIVE_INFINITY;

		for (const batch of batches) {
			const exit = yield* Effect.exit(
				kit.seed(seedInput(tableId, snapshot, batch, batch.events))
			);

			if (Exit.isFailure(exit)) {
				if (Cause.hasInterruptsOnly(exit.cause)) {
					return yield* Effect.interrupt;
				}

				const [first] = batch.events;

				const fallback: Halt = {
					seq: first?.seq ?? snapshot.version + 1,
					cause: exit.cause,
				};

				const halt = Option.getOrElse(
					yield* locate(kit, tableId, snapshot, batch),
					() => fallback
				);

				return yield* Effect.die(
					new LogError({
						message: `Replay halted at seq ${halt.seq}: ${describe(halt.cause)}`,
						cause: Cause.squash(halt.cause),
					})
				);
			}

			snapshot = { state: exit.value.state, version: exit.value.version };
			last = Math.max(last, batch.at);
		}

		return { snapshot, last };
	});

export class JsonlPlatform extends Context.Service<
	JsonlPlatform,
	Platform["Service"]
>()("@supervillain/platform-jsonl/JsonlPlatform") {
	static readonly make = (tableId: string) =>
		Effect.gen(function* () {
			const scope = yield* Scope.Scope;
			const log = yield* CampaignLog;
			const pending = yield* Ref.make(yield* prepare());
			const hosting = yield* Ref.make(Option.none<string>());

			const openStore = Effect.fn("JsonlPlatform.aggregate")(function* (
				kit: AggregateKit
			) {
				const existing = yield* Ref.modify(hosting, (current) =>
					Option.isSome(current)
						? ([current, current] as const)
						: ([Option.none<string>(), Option.some(kit.name)] as const)
				);

				if (Option.isSome(existing)) {
					return yield* Effect.die(
						new Unsupported({
							message: `JsonlPlatform hosts one aggregate: ${existing.value} is here, so ${kit.name} cannot be`,
						})
					);
				}

				const replayed = yield* replay(
					kit,
					tableId,
					yield* Ref.getAndSet(pending, [])
				);

				const source: Source = {
					id: tableId,
					stream: `${kit.name}/${tableId}`,
				};

				const snapshot = yield* SubscriptionRef.make(replayed.snapshot);

				const writer = yield* Ref.make<Writer>({
					last: replayed.last,
					halted: Option.none(),
				});

				const published = yield* PubSub.unbounded<StoredEvent>();
				yield* Scope.addFinalizer(scope, PubSub.shutdown(published));

				const permit = yield* Semaphore.make(1);
				const receipts = new Map<string, SendResult>();

				const commit = (id: string, command: Json, meta: SendMeta) =>
					Effect.gen(function* () {
						if (id !== tableId) {
							return refused(
								`JsonlPlatform hosts the instance ${tableId}, not ${id}`
							);
						}

						const current = yield* Ref.get(writer);

						if (Option.isSome(current.halted)) {
							return refused(`The room is halted: ${current.halted.value}`);
						}

						const duplicate = receipts.get(meta.commandId);

						if (duplicate !== undefined) {
							remember(receipts, meta.commandId, duplicate);

							return duplicate;
						}

						const clock = yield* Clock.currentTimeMillis;
						const now = Math.max(clock, current.last + 1);
						const before = yield* SubscriptionRef.get(snapshot);
						const { commandId, context, ...flow } = meta;

						const input: HandleInput = {
							...flow,
							id,
							state: before.state,
							version: before.version,
							command,
							commandId,
							context,
							now,
						};

						const handled = yield* Effect.exit(kit.handle(input));

						if (Exit.isFailure(handled)) {
							if (Cause.hasInterruptsOnly(handled.cause)) {
								return yield* Effect.interrupt;
							}

							return refused(
								`Rule error, nothing written: ${describe(handled.cause)}`
							);
						}

						const result = handled.value;

						if (Predicate.isTagged(result, "Rejected")) {
							return Rejected.make({ rejection: result.rejection });
						}

						const encoded = yield* Effect.result(encodeLines(result.events));

						if (Result.isFailure(encoded)) {
							return refused(
								`Rule error, nothing written: ${encoded.failure.message}`
							);
						}

						return yield* Effect.uninterruptible(
							Effect.gen(function* () {
								const written = yield* Effect.result(
									log.append(encoded.success)
								);

								if (Result.isFailure(written)) {
									const reason = written.failure.message;
									yield* Ref.set(writer, {
										last: current.last,
										halted: Option.some(reason),
									});

									return refused(`Log write failed, room halted: ${reason}`);
								}

								yield* Ref.set(writer, { last: now, halted: Option.none() });
								yield* SubscriptionRef.set(snapshot, {
									state: result.state,
									version: result.version,
								});
								yield* PubSub.publishAll(published, result.events);

								const sent: SendResult = Accepted.make({
									receipt: {
										stream: source.stream,
										version: result.version,
										events: result.events.map((stored) => stored.event),
										reply: result.reply,
									},
								});

								remember(receipts, commandId, sent);

								return sent;
							})
						);
					});

				const history = (after: number) =>
					Effect.gen(function* () {
						const batches = yield* batchesAfter(log, after, 1);

						const wanted = batches.filter((batch) => lastSeq(batch) > after);

						const decoded = yield* Effect.forEach(
							wanted,
							(batch) => decodeBatch(batch, source),
							{ concurrency: 1 }
						);

						return decoded
							.flat()
							.filter((stored) => stored.envelope.seq > after);
					});

				const store: AggregateStore = {
					send: (id, command, meta) =>
						commit(id, command, meta).pipe(
							Semaphore.withPermit(permit),
							Effect.withSpan("JsonlPlatform.send")
						),
					schedule: () =>
						Effect.die(
							new Unsupported({
								message: "JsonlPlatform does not schedule commands",
							})
						),
					unschedule: () =>
						Effect.die(
							new Unsupported({
								message: "JsonlPlatform does not schedule commands",
							})
						),
					state: (id) =>
						id === tableId
							? SubscriptionRef.get(snapshot)
							: Effect.die(stranger(tableId, id)),
					changes: (id) =>
						id === tableId
							? SubscriptionRef.changes(snapshot)
							: Stream.die(stranger(tableId, id)),
					tail: (id, after) =>
						id === tableId
							? Stream.unwrap(
									Effect.gen(function* () {
										const subscription = yield* PubSub.subscribe(published);
										const past = yield* history(after).pipe(Effect.orDie);
										const last = past.at(-1)?.envelope.seq ?? after;

										return Stream.concat(
											Stream.fromIterable(past),
											Stream.fromSubscription(subscription).pipe(
												Stream.filter((stored) => stored.envelope.seq > last)
											)
										);
									})
								)
							: Stream.die(stranger(tableId, id)),
				};

				return store;
			});

			const host: ModelHost = {
				aggregate: (_aggregate, kit) => openStore(kit),
				view: (view) =>
					Effect.die(
						new Unsupported({
							message: `JsonlPlatform hosts one aggregate, not the view ${view.viewName}`,
						})
					),
				policy: (policy) =>
					Effect.die(
						new Unsupported({
							message: `JsonlPlatform hosts one aggregate, not the policy ${policy.policyName}`,
						})
					),
				projection: (projection) =>
					Effect.die(
						new Unsupported({
							message: `JsonlPlatform hosts one aggregate, not the projection ${projection.projectionName}`,
						})
					),
				stream: (stream) =>
					Effect.die(
						new Unsupported({
							message: `JsonlPlatform hosts one aggregate, not the stream ${stream.streamName}`,
						})
					),
			};

			return {
				model: () =>
					Effect.succeed(host).pipe(Effect.withSpan("JsonlPlatform.model")),
			};
		});

	static readonly layer = (options: JsonlPlatformOptions) =>
		Layer.effect(this, this.make(options.tableId)).pipe(
			Layer.flatMap((context) =>
				Layer.succeed(Platform, Context.get(context, JsonlPlatform))
			),
			Layer.provideMerge(CampaignLog.layer(options.dir))
		);

	static readonly layerMemory = (options: MemoryPlatformOptions) =>
		Layer.effect(this, this.make(options.tableId)).pipe(
			Layer.flatMap((context) =>
				Layer.succeed(Platform, Context.get(context, JsonlPlatform))
			),
			Layer.provideMerge(CampaignLog.layerMemory(options.cap))
		);
}
