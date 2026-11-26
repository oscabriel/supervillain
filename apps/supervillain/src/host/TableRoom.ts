import {
	ActorId,
	CurrentActor,
	Entropy,
	GM,
	playerActor,
	Supervillain,
	Table,
	THE_TABLE,
	toTableCommand,
} from "@supervillain/domain";
import type {
	Command,
	TableCommand,
	TableEvent,
	TableState,
} from "@supervillain/domain";
import {
	CampaignLog,
	JsonlPlatform,
	LogError,
} from "@supervillain/platform-jsonl";
import type { Line } from "@supervillain/platform-jsonl";
import { rateLimiter } from "@supervillain/ssh";
import type { Rate } from "@supervillain/ssh";
import {
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Schema,
	SubscriptionRef,
} from "effect";
import type { FileSystem, Path, Stream } from "effect";
import { SecureRandom } from "effect/crypto";

export const PLAYER_RATE: Rate = { burst: 10, perSecond: 2 };

const SEED_TOP = 0xff_ff_ff_ff;

export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const SANDBOX_LOG_CAP = 2000;

export interface TableRoomOptions {
	readonly playerRate?: Rate;
	readonly sandbox?: boolean;
	readonly logCap?: number;
}

export interface Accepted {
	readonly seqs: ReadonlyArray<number>;
	readonly events: ReadonlyArray<TableEvent>;
}

const isTableCommand = (
	command: Command | TableCommand
): command is TableCommand => "_tag" in command;

const decodeActor = Schema.decodeUnknownEffect(ActorId);

const commandOf = (command: Command | TableCommand) =>
	isTableCommand(command) ? Effect.succeed(command) : toTableCommand(command);

const newer = (next: TableState) => (current: TableState) =>
	next.seq >= current.seq ? next : current;

export class TableRoom extends Context.Service<
	TableRoom,
	{
		readonly submit: (
			actor: string,
			command: Command | TableCommand,
			rateKey?: string
		) => Effect.Effect<Accepted, Refusal>;
		readonly state: Effect.Effect<TableState>;
		readonly changes: Stream.Stream<TableState>;
		readonly recent: (
			count: number
		) => Effect.Effect<ReadonlyArray<Line>, LogError>;
		readonly actors: Effect.Effect<ReadonlySet<string>>;
	}
>()("supervillain/host/TableRoom") {
	static readonly make = (options: TableRoomOptions) =>
		Effect.gen(function* () {
			const table = yield* Table;
			const log = yield* CampaignLog;
			const random = yield* SecureRandom.SecureRandom;
			const current = yield* SubscriptionRef.make(yield* table.get(THE_TABLE));
			const take = rateLimiter(options.playerRate ?? PLAYER_RATE);

			const throttle = Effect.fn("TableRoom.throttle")(function* (
				actor: ActorId,
				rateKey: string
			) {
				const now = yield* Clock.currentTimeMillis;

				const limited = actor !== GM || options.sandbox === true;

				return yield* limited && !take(rateKey, now)
					? Effect.fail(
							new Refusal({
								message: "You're sending lines too fast; wait a moment.",
							})
						)
					: Effect.void;
			});

			const submit = Effect.fn("TableRoom.submit")(
				function* (
					actor: string,
					command: Command | TableCommand,
					rateKey?: string
				) {
					const id = yield* decodeActor(actor).pipe(
						Effect.mapError(
							(cause) =>
								new Refusal({
									message: `${actor} can't sit at this table.`,
									cause,
								})
						)
					);

					yield* throttle(id, rateKey ?? actor);
					const sent = yield* commandOf(command);
					const seed = yield* random.intBetween(0, SEED_TOP);

					const receipt = yield* Effect.uninterruptible(
						Effect.gen(function* () {
							const sentReceipt = yield* table
								.send(THE_TABLE, sent)
								.pipe(
									Effect.provideService(CurrentActor, playerActor(id)),
									Effect.provideService(Entropy, { seed })
								);

							const updated = yield* table.get(THE_TABLE);
							yield* SubscriptionRef.update(current, newer(updated));

							return sentReceipt;
						})
					);

					const first = receipt.version - receipt.events.length + 1;

					const accepted: Accepted = {
						seqs: receipt.events.map((_event, index) => first + index),
						events: receipt.events,
					};

					return accepted;
				},
				Effect.mapError((refused) =>
					refused instanceof Refusal
						? refused
						: new Refusal({ message: refused.message })
				)
			);

			return TableRoom.of({
				submit,
				state: SubscriptionRef.get(current),
				changes: SubscriptionRef.changes(current),
				recent: log.recent,
				actors: Effect.map(
					SubscriptionRef.get(current),
					(state): ReadonlySet<string> => new Set(state.actors)
				).pipe(Effect.withSpan("TableRoom.actors")),
			});
		});

	static readonly layer = (
		campaignDir: string,
		options: TableRoomOptions = {}
	): Layer.Layer<TableRoom, LogError, FileSystem.FileSystem | Path.Path> =>
		Layer.effect(TableRoom, TableRoom.make(options)).pipe(
			Layer.provide(
				Supervillain.layer(Layer.empty).pipe(
					Layer.provideMerge(
						options.sandbox === true
							? JsonlPlatform.layerMemory({
									tableId: THE_TABLE,
									cap: options.logCap ?? SANDBOX_LOG_CAP,
								})
							: JsonlPlatform.layer({ dir: campaignDir, tableId: THE_TABLE })
					),
					Layer.provideMerge(SecureRandom.layerWebCrypto)
				)
			),
			Layer.catchCause((cause) => {
				const squashed = Cause.squash(cause);

				return squashed instanceof LogError
					? Layer.effect(TableRoom, Effect.fail(squashed))
					: Layer.effect(TableRoom, Effect.failCause(cause));
			})
		);
}
