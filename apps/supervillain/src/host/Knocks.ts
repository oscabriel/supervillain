import {
	ActorId,
	knockerNamed,
	Knocks as KnocksPort,
	shortFingerprint,
} from "@supervillain/domain";
import type { Knocker } from "@supervillain/domain";
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	Ref,
	Schema,
	Semaphore,
	SubscriptionRef,
} from "effect";
import type { Scope } from "effect";
import { SecureRandom } from "effect/crypto";

import { crockford } from "../relay/protocol.ts";
import type { View } from "./View.ts";

export interface Knock extends Knocker {
	readonly bucket: string;
	readonly at: number;
}

export type KnockEnd = "denied" | "expired";

export interface KnockWait {
	readonly ended: Effect.Effect<KnockEnd>;
}

export interface Invite {
	readonly token: string;
	readonly uses: number;
	readonly until: number;
}

export interface InviteAsk {
	readonly uses?: number;
	readonly minutes?: number;
}

export class KnockRefused extends Schema.TaggedError<KnockRefused>()(
	"KnockRefused",
	{ message: Schema.String }
) {}

export const KNOCK_LIMITS = {
	pending: 16,
	perAddress: 3,
	expireMs: 10 * 60_000,
	cooldownMs: 10 * 60_000,
} as const;

export const INVITE_LIMITS = {
	uses: 1,
	minutes: 60,
	mostUses: 32,
	mostMinutes: 24 * 60,
	live: 32,
	tokenBytes: 10,
} as const;

const MINUTE_MS = 60_000;

const KNOCK_LINE = /^\s*\/(?<verb>admit|deny)\s+(?<partial>.*)$/iu;

const cooldownKeys = (
	knock: Knocker & { readonly bucket: string }
): ReadonlyArray<string> =>
	knock.actor.startsWith("key:")
		? [knock.actor, `bucket:${knock.bucket}`]
		: [`bucket:${knock.bucket}`];

const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, Math.floor(value)));

export const knockLabel = (knock: Knocker): string =>
	`${knock.name} (${shortFingerprint(knock.fingerprint)})`;

export const knockCompletions = (
	line: string,
	knocks: ReadonlyArray<Knocker>
): ReadonlyArray<string> | undefined => {
	const groups = KNOCK_LINE.exec(line)?.groups;

	if (groups === undefined) {
		return undefined;
	}

	const verb = (groups.verb ?? "").toLowerCase();
	const typed = (groups.partial ?? "").trim().toLowerCase();

	return knocks.flatMap((k) =>
		k.name.toLowerCase().startsWith(typed) ? [`/${verb} ${k.name}`] : []
	);
};

export const inviteCommand = (joinCommand: string, token: string): string => {
	const at = joinCommand.lastIndexOf("@");

	return at === -1
		? `${joinCommand} (add ~${token} to the table's name)`
		: `${joinCommand.slice(0, at)}~${token}${joinCommand.slice(at)}`;
};

export const inviteTokenOf = (user: string): string | undefined => {
	const at = user.lastIndexOf("~");

	if (at === -1) {
		return undefined;
	}

	const token = user.slice(at + 1);

	return token === "" ? undefined : token;
};

export class Knocks extends Context.Service<
	Knocks,
	{
		readonly pending: View<ReadonlyArray<Knock>>;
		readonly knock: (
			knocker: Knocker & { readonly bucket: string }
		) => Effect.Effect<KnockWait, KnockRefused, Scope.Scope>;
		readonly deny: (who: string) => Effect.Effect<Knock | undefined>;
		readonly invite: (ask: InviteAsk) => Effect.Effect<Invite, KnockRefused>;
		readonly holds: (token: string) => Effect.Effect<boolean>;
		readonly redeem: (token: string) => Effect.Effect<boolean>;
		readonly settle: (token: string, used: boolean) => Effect.Effect<void>;
		readonly advertise: (joinCommand: string) => Effect.Effect<void>;
		readonly joinCommand: Effect.Effect<string | undefined>;
	}
>()("supervillain/host/Knocks") {
	static readonly make = Effect.gen(function* () {
		const random = yield* SecureRandom.SecureRandom;
		const knocks = yield* SubscriptionRef.make<ReadonlyArray<Knock>>([]);
		const advertised = yield* Ref.make<string | undefined>(undefined);
		const lock = yield* Semaphore.make(1);
		const waiting = new Map<string, Deferred.Deferred<KnockEnd>>();
		const cooldowns = new Map<string, number>();

		const invites = new Map<
			string,
			{ uses: number; until: number; held: number }
		>();

		const sweep = (now: number) => {
			for (const [key, until] of cooldowns) {
				if (until <= now) {
					cooldowns.delete(key);
				}
			}

			for (const [token, invite] of invites) {
				if (invite.until <= now || (invite.uses <= 0 && invite.held <= 0)) {
					invites.delete(token);
				}
			}
		};

		const refusalFor = (
			knocker: Knocker & { readonly bucket: string },
			pending: ReadonlyArray<Knock>,
			now: number
		): string | undefined => {
			const until = Math.max(
				0,
				...cooldownKeys(knocker).map((key) => cooldowns.get(key) ?? 0)
			);

			if (until > now) {
				return `The GM turned you away; try again in ${Math.ceil((until - now) / MINUTE_MS)} min.`;
			}

			if (pending.some((k) => k.actor === knocker.actor)) {
				return "You're already knocking from another terminal.";
			}

			if (pending.length >= KNOCK_LIMITS.pending) {
				return "Too many people are knocking right now; try again in a bit.";
			}

			return pending.filter((k) => k.bucket === knocker.bucket).length >=
				KNOCK_LIMITS.perAddress
				? "Too many knocks from your address; try again in a bit."
				: undefined;
		};

		const enter = Effect.fn("Knocks.enter")(function* (
			knocker: Knocker & { readonly bucket: string }
		) {
			const now = yield* Clock.currentTimeMillis;
			sweep(now);
			const pending = yield* SubscriptionRef.get(knocks);
			const refusal = refusalFor(knocker, pending, now);

			if (refusal !== undefined) {
				return yield* new KnockRefused({ message: refusal });
			}

			const decided = yield* Deferred.make<KnockEnd>();
			const knock: Knock = { ...knocker, at: now };
			waiting.set(knock.actor, decided);
			yield* SubscriptionRef.update(knocks, (xs) => [...xs, knock]);

			return { knock, decided };
		});

		const leave = (knock: Knock) =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					waiting.delete(knock.actor);
					yield* SubscriptionRef.update(knocks, (xs) =>
						xs.filter((k) => k !== knock)
					);
				})
			);

		const knock = Effect.fn("Knocks.knock")(function* (
			knocker: Knocker & { readonly bucket: string }
		) {
			const { knock: entered, decided } = yield* Effect.acquireRelease(
				lock.withPermits(1)(enter(knocker)),
				({ knock: placed }) => leave(placed)
			);

			const wait: KnockWait = {
				ended: Deferred.await(decided).pipe(
					Effect.timeoutOrElse({
						duration: KNOCK_LIMITS.expireMs,
						orElse: () => Effect.succeed<KnockEnd>("expired"),
					}),
					Effect.ensuring(leave(entered))
				),
			};

			return wait;
		});

		const deny = Effect.fn("Knocks.deny")(function* (who: string) {
			return yield* lock.withPermits(1)(
				Effect.gen(function* () {
					const pending = yield* SubscriptionRef.get(knocks);
					const found = knockerNamed(pending, who);
					const denied = pending.find((k) => k.actor === found?.actor);

					if (denied !== undefined) {
						const now = yield* Clock.currentTimeMillis;

						for (const key of cooldownKeys(denied)) {
							cooldowns.set(key, now + KNOCK_LIMITS.cooldownMs);
						}

						const decided = waiting.get(denied.actor);
						waiting.delete(denied.actor);
						yield* SubscriptionRef.update(knocks, (xs) =>
							xs.filter((k) => k !== denied)
						);

						if (decided !== undefined) {
							yield* Deferred.succeed(decided, "denied");
						}
					}

					return denied;
				})
			);
		});

		const invite = Effect.fn("Knocks.invite")(function* (ask: InviteAsk) {
			const now = yield* Clock.currentTimeMillis;
			sweep(now);

			if (invites.size >= INVITE_LIMITS.live) {
				return yield* new KnockRefused({
					message: `There are ${INVITE_LIMITS.live} invites out already; wait for some to run out.`,
				});
			}

			const uses = clamp(
				ask.uses ?? INVITE_LIMITS.uses,
				1,
				INVITE_LIMITS.mostUses
			);

			const minutes = clamp(
				ask.minutes ?? INVITE_LIMITS.minutes,
				1,
				INVITE_LIMITS.mostMinutes
			);

			const bytes = yield* random.randomBytes(INVITE_LIMITS.tokenBytes);
			const token = crockford(bytes, 16);
			const until = now + minutes * MINUTE_MS;
			invites.set(token, { uses, until, held: 0 });

			const made: Invite = { token, uses, until };

			return made;
		});

		const holds = Effect.fn("Knocks.holds")(function* (token: string) {
			const now = yield* Clock.currentTimeMillis;
			sweep(now);

			return (invites.get(token.toLowerCase())?.uses ?? 0) > 0;
		});

		const redeem = Effect.fn("Knocks.redeem")(function* (token: string) {
			const now = yield* Clock.currentTimeMillis;
			sweep(now);
			const minted = invites.get(token.toLowerCase());

			if (minted === undefined || minted.uses <= 0) {
				return false;
			}

			minted.uses -= 1;
			minted.held += 1;

			return true;
		});

		const settle = Effect.fn("Knocks.settle")(function* (
			token: string,
			used: boolean
		) {
			const minted = invites.get(token.toLowerCase());

			if (minted !== undefined) {
				minted.held = Math.max(0, minted.held - 1);

				if (!used) {
					minted.uses += 1;
				}
			}

			sweep(yield* Clock.currentTimeMillis);
		});

		return Knocks.of({
			pending: {
				get: SubscriptionRef.get(knocks),
				changes: SubscriptionRef.changes(knocks),
			},
			knock,
			deny,
			invite,
			holds,
			redeem,
			settle,
			advertise: (joinCommand) => Ref.set(advertised, joinCommand),
			joinCommand: Ref.get(advertised),
		});
	});

	static readonly layer = Layer.effect(Knocks, Knocks.make);
}

const isActorId = Schema.is(ActorId);

export const KnocksLive = KnocksPort.toLayer(
	Effect.gen(function* () {
		const knocks = yield* Knocks;

		return {
			pending: Effect.fn("Knocks.pending")(function* () {
				const pending = yield* knocks.pending.get;

				return pending.flatMap(({ actor, name, fingerprint }) =>
					isActorId(actor) ? [{ actor, name, fingerprint }] : []
				);
			}),
		};
	})
);
