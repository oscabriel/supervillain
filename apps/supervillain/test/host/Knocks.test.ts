import { describe, expect, test } from "bun:test";

import { ActorId, Knocks as KnocksPort } from "@supervillain/domain";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";

import {
	INVITE_LIMITS,
	inviteCommand,
	inviteTokenOf,
	KNOCK_LIMITS,
	knockCompletions,
	knockLabel,
	Knocks,
	KnocksLive,
} from "../../src/host/Knocks.ts";
import { effect } from "./effect.ts";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const withKnocks = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	using(
		Layer.mergeAll(
			TestClock.layer(),
			KnocksLive.pipe(Layer.provideMerge(Knocks.layer))
		),
		body
	);

const knocker = (n: number, bucket = "203.0.113.7") => ({
	actor: ActorId.make(`key:SHA256:${String(n).padStart(43, "k")}`),
	name: `Player ${n}`,
	fingerprint: `SHA256:${String(n).padStart(43, "k")}`,
	bucket,
});

const knockIn = (n: number, bucket?: string) =>
	Effect.gen(function* () {
		const knocks = yield* Knocks;
		const scope = yield* Scope.make();

		const ended = yield* knocks
			.knock(knocker(n, bucket))
			.pipe(Scope.provide(scope));

		return { ended, leave: Scope.close(scope, Exit.void) };
	});

const pendingNames = Effect.flatMap(Knocks, (k) => k.pending.get).pipe(
	Effect.map((xs) => xs.map((x) => x.name))
);

describe("Knocks", () => {
	effect(
		"a knock waits at the door until it's denied, and the port lists who is knocking",
		() =>
			withKnocks(
				Effect.gen(function* () {
					const knocks = yield* Knocks;
					const { ended } = yield* knockIn(1);
					expect(yield* pendingNames).toEqual(["Player 1"]);
					expect(yield* (yield* KnocksPort).pending()).toEqual([
						{
							actor: knocker(1).actor,
							name: "Player 1",
							fingerprint: knocker(1).fingerprint,
						},
					]);

					const waiting = yield* Effect.forkChild(ended.ended);
					expect(yield* knocks.deny("nobody")).toBeUndefined();
					expect((yield* knocks.deny("player 1"))?.name).toBe("Player 1");
					expect(yield* Fiber.join(waiting)).toBe("denied");
					expect(yield* pendingNames).toEqual([]);
				})
			)
	);

	effect("a denied key can't knock again for ten minutes; then it can", () =>
		withKnocks(
			Effect.gen(function* () {
				const knocks = yield* Knocks;
				yield* knockIn(1);
				yield* knocks.deny("Player 1");
				const again = yield* Effect.flip(knockIn(1));
				expect(again.message).toBe(
					"The GM turned you away; try again in 10 min."
				);
				yield* TestClock.adjust(KNOCK_LIMITS.cooldownMs);
				yield* knockIn(1);
				expect(yield* pendingNames).toEqual(["Player 1"]);
			})
		)
	);

	effect(
		"a denied address can't knock again under a fresh key or as a guest for ten minutes",
		() =>
			withKnocks(
				Effect.gen(function* () {
					const knocks = yield* Knocks;
					const knocksOf = Effect.flatMap(Knocks, (k) => k.pending.get);
					yield* knockIn(1, "relayed:gm/abc");
					yield* knocks.deny("Player 1");
					expect(
						(yield* Effect.flip(knockIn(2, "relayed:gm/abc"))).message
					).toBe("The GM turned you away; try again in 10 min.");

					const guest = yield* Scope.make();

					const asGuest = yield* Effect.flip(
						knocks
							.knock({
								actor: ActorId.make("guest:fresh"),
								name: "Fresh",
								fingerprint: "guest:fresh",
								bucket: "relayed:gm/abc",
							})
							.pipe(Scope.provide(guest))
					);

					expect(asGuest.message).toBe(
						"The GM turned you away; try again in 10 min."
					);
					yield* knockIn(3, "relayed:gm/xyz");
					expect((yield* knocksOf).map((k) => k.name)).toEqual(["Player 3"]);
					yield* TestClock.adjust(KNOCK_LIMITS.cooldownMs);
					yield* knockIn(2, "relayed:gm/abc");
				})
			)
	);

	effect("an unanswered knock expires after ten minutes", () =>
		withKnocks(
			Effect.gen(function* () {
				const { ended } = yield* knockIn(1);
				const waiting = yield* Effect.forkChild(ended.ended);
				yield* TestClock.adjust(KNOCK_LIMITS.expireMs);
				expect(yield* Fiber.join(waiting)).toBe("expired");
				expect(yield* pendingNames).toEqual([]);
			})
		)
	);

	effect(
		"one knock a key, three an address, sixteen in all; leaving the door frees a place",
		() =>
			withKnocks(
				Effect.gen(function* () {
					const first = yield* knockIn(1, "198.51.100.1");
					expect((yield* Effect.flip(knockIn(1, "198.51.100.9"))).message).toBe(
						"You're already knocking from another terminal."
					);
					yield* knockIn(2, "198.51.100.1");
					yield* knockIn(3, "198.51.100.1");
					expect((yield* Effect.flip(knockIn(4, "198.51.100.1"))).message).toBe(
						"Too many knocks from your address; try again in a bit."
					);
					yield* first.leave;
					yield* knockIn(4, "198.51.100.1");

					for (const n of Array.from({ length: 13 }, (_, i) => i + 10)) {
						yield* knockIn(n, `192.0.2.${n}`);
					}

					expect(yield* pendingNames).toHaveLength(KNOCK_LIMITS.pending);
					expect((yield* Effect.flip(knockIn(99, "192.0.2.99"))).message).toBe(
						"Too many people are knocking right now; try again in a bit."
					);
				})
			)
	);

	effect("an invite is good for its uses and its minutes, and never more", () =>
		withKnocks(
			Effect.gen(function* () {
				const knocks = yield* Knocks;
				const two = yield* knocks.invite({ uses: 2, minutes: 5 });
				expect(two.token).toMatch(/^[0-9a-z]{16}$/u);
				expect(two.uses).toBe(2);
				expect(yield* knocks.holds(two.token)).toBe(true);
				expect(yield* knocks.redeem(two.token.toUpperCase())).toBe(true);
				expect(yield* knocks.redeem(two.token)).toBe(true);
				expect(yield* knocks.redeem(two.token)).toBe(false);
				expect(yield* knocks.holds(two.token)).toBe(false);

				const brief = yield* knocks.invite({ minutes: 1 });
				expect(brief.uses).toBe(INVITE_LIMITS.uses);
				yield* TestClock.adjust("1 minute");
				expect(yield* knocks.redeem(brief.token)).toBe(false);

				const capped = yield* knocks.invite({ uses: 999, minutes: 99_999 });
				expect(capped.uses).toBe(INVITE_LIMITS.mostUses);
				expect(capped.until).toBe(INVITE_LIMITS.mostMinutes * 60_000 + 60_000);
				expect(yield* knocks.redeem("not-a-token")).toBe(false);
			})
		)
	);

	effect(
		"an invite use is held while the admission runs, and handed back if it fails",
		() =>
			withKnocks(
				Effect.gen(function* () {
					const knocks = yield* Knocks;
					const one = yield* knocks.invite({ uses: 1, minutes: 5 });
					expect(yield* knocks.redeem(one.token)).toBe(true);
					expect(yield* knocks.holds(one.token)).toBe(false);
					expect(yield* knocks.redeem(one.token)).toBe(false);
					yield* knocks.settle(one.token, false);
					expect(yield* knocks.holds(one.token)).toBe(true);
					expect(yield* knocks.redeem(one.token)).toBe(true);
					yield* knocks.settle(one.token, true);
					expect(yield* knocks.holds(one.token)).toBe(false);
					yield* knocks.settle(one.token, false);
					expect(yield* knocks.holds(one.token)).toBe(false);
				})
			)
	);

	effect("the relay's join command is advertised for invites", () =>
		withKnocks(
			Effect.gen(function* () {
				const knocks = yield* Knocks;
				expect(yield* knocks.joinCommand).toBeUndefined();
				yield* knocks.advertise("ssh ana/den@relay.example");
				expect(yield* knocks.joinCommand).toBe("ssh ana/den@relay.example");
			})
		)
	);
});

describe("knock helpers", () => {
	test("an invite goes after the table's name, before the @", () => {
		expect(inviteCommand("ssh ana/den@relay.example", "t0k")).toBe(
			"ssh ana/den~t0k@relay.example"
		);
		expect(inviteCommand("ssh -p 2222 den@127.0.0.1", "t0k")).toBe(
			"ssh -p 2222 den~t0k@127.0.0.1"
		);
		expect(inviteTokenOf("den~t0k")).toBe("t0k");
		expect(inviteTokenOf("den")).toBeUndefined();
		expect(inviteTokenOf("den~")).toBeUndefined();
	});

	test("/admit and /deny complete the names of who is knocking", () => {
		const knocks = [knocker(1), { ...knocker(2), name: "Ana" }];
		expect(knockCompletions("/admit ", knocks)).toEqual([
			"/admit Player 1",
			"/admit Ana",
		]);
		expect(knockCompletions("/deny a", knocks)).toEqual(["/deny Ana"]);
		expect(knockCompletions("/say a", knocks)).toBeUndefined();
		expect(knockLabel(knocker(1))).toBe("Player 1 (kkkkkkkk)");
	});
});
