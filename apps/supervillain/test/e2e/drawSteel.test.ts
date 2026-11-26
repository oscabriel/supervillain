import { describe, expect } from "bun:test";

import { bandOf, feedLines, plainText, tableLabel } from "@supervillain/domain";
import { Effect, Schema } from "effect";

import { must } from "../game/must.ts";
import { openSampleCampaign } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { asGm, asPlayer, hostTable, logOf } from "./hosted.ts";
import type { Hosted } from "./hosted.ts";
import { clientKey, sshExec } from "./openssh.ts";

const projection = (table: Hosted, actors: ReadonlyArray<string>) =>
	Effect.map(table.state, (s) => ({
		bands: actors.map((a) => bandOf(s, a, "draw-steel")),
		feed: feedLines(s, tableLabel(s, "draw-steel")).map(plainText),
		state: s,
	}));

const decodeRoll = Schema.decodeUnknownSync(
	Schema.Struct({
		dice: Schema.Tuple([Schema.Finite, Schema.Finite]),
		total: Schema.Finite,
		tier: Schema.Finite,
	})
);

const decodeSaves = Schema.decodeUnknownSync(
	Schema.Struct({
		saves: Schema.Array(
			Schema.Struct({ condition: Schema.String, roll: Schema.Finite })
		),
	})
);

const tierOf = (total: number) => {
	if (total <= 11) {
		return 1;
	}

	return total <= 16 ? 2 : 3;
};

describe("a short Draw Steel encounter over real ssh", () => {
	effect(
		"the GM sets up from the sample campaign, players act over exec, and a restart replays it",
		() =>
			Effect.gen(function* () {
				const dir = yield* openSampleCampaign;
				const keys = yield* tempDir;
				const alice = yield* clientKey(keys, "alice");
				const bob = yield* clientKey(keys, "bob");
				const aliceActor = `key:${alice.fingerprint}`;
				const bobActor = `key:${bob.fingerprint}`;
				const everyone = ["gm", aliceActor, bobActor];

				let table = yield* hostTable(dir);
				const { port } = table;
				yield* asPlayer(port, alice, "/name Alice");
				yield* asPlayer(port, bob, "/name Bob");

				const joined = yield* asGm(table, "/hero brann");
				expect(joined).toHaveLength(1);
				expect(must(joined[0])).toMatch(/^Brann joins the party:/u);
				yield* asGm(table, "/hero kesh");
				expect(yield* asPlayer(port, alice, "/play brann")).toBe(
					"Alice takes Brann.\n"
				);
				expect(yield* asPlayer(port, bob, "/play kesh")).toBe(
					"Bob takes Kesh.\n"
				);

				expect(yield* asGm(table, "/add bandit-cutpurse x4")).toEqual([
					"Bandit Cutpurse A (4 minions) joins the fight.",
				]);
				expect(yield* asGm(table, "/add bandit-chief")).toEqual([
					"Bandit Chief joins the fight.",
				]);
				const started = yield* asGm(table, "/start");
				expect(started[0]).toMatch(
					/^Combat begins, round 1\. d10: (?:[1-9]|10), so (?:the players pick|the Director picks) who goes first, .* Malice \+3 \(0 for Victories, 2 heroes, round 1\) → 3\. The party has no hero tokens; \/token reset gives one per hero\.$/u
				);
				yield* asGm(table, "/first heroes");

				expect(yield* asPlayer(port, alice, "/turn")).toBe(
					"Brann's turn. wrath +2 → 2.\n"
				);
				const blow = yield* asPlayer(port, alice, "/pr brann driving");
				expect(blow).toMatch(
					/^Brann uses Driving Blow: \[\d+, \d+\] \+2 = \d+.* · tier [123] — /u
				);
				const rolled = must((yield* logOf(dir)).at(-1));
				expect(rolled).toMatchObject({
					actor: aliceActor,
					type: "ds.power-rolled",
					payload: {
						id: "brann",
						ability: "Driving Blow",
						bonus: 2,
						edges: 0,
						banes: 0,
					},
				});

				const roll = decodeRoll(rolled.payload);
				const [first, second] = roll.dice;

				expect(roll.dice.every((d) => d >= 1 && d <= 10)).toBe(true);
				expect(roll.total).toBe(first + second + 2);
				expect(roll.tier).toBe(tierOf(roll.total));

				const damaged = yield* asGm(table, "/dmg bandit-cutpurse-a 7");
				expect(damaged).toHaveLength(1);
				expect(must(damaged[0])).toMatch(
					/^Bandit Cutpurse A takes 7 damage → 13\/20 · 1 minion dies, 3 left/u
				);
				expect(yield* asPlayer(port, alice, "/cond brann slowed save")).toBe(
					"Brann is slowed (save ends).\n"
				);
				const ended = yield* asPlayer(port, alice, "/done");
				expect(ended).toMatch(
					/^Brann's turn ends\. Save against slowed: (?:[1-9]|10), it (?:ends|goes on)\.\n$/u
				);
				const save = must((yield* logOf(dir)).at(-1));
				expect(save).toMatchObject({
					type: "ds.turn-ended",
					payload: { id: "brann", ended: [] },
				});

				const [saved] = decodeSaves(save.payload).saves;

				expect(must(saved).condition).toBe("slowed");

				const brann = must(
					(yield* table.state).ds.heroes.find((h) => h.id === "brann")
				);

				expect(brann.conditions).toEqual(
					must(saved).roll >= 6 ? [] : [{ name: "slowed", duration: "save" }]
				);

				expect(yield* sshExec(port, "/turn", bob)).toMatchObject({
					exitCode: 1,
					stderr: "It's the Director's turn to pick a creature.\n",
				});
				expect(yield* asGm(table, "/turn bandit-chief")).toEqual([
					"Bandit Chief's turn.",
				]);
				expect(yield* asGm(table, "/fs bandit-chief kesh")).toEqual([
					"Bandit Chief free strikes: Kesh takes 4 damage → 20/24",
				]);
				yield* asGm(table, "/done");
				expect(yield* asPlayer(port, bob, "/turn")).toMatch(
					/^Kesh's turn\. ferocity \+[123] \(1d3: [123]\) → [123]\.\n$/u
				);
				expect(yield* asPlayer(port, alice, "/sheet kesh")).toStartWith(
					"Kesh: Fury 1\nStamina 20/24"
				);
				yield* asGm(table, "/turn bandit-cutpurse-a");

				const before = yield* projection(table, everyone);
				expect(before.bands[1]).toMatchObject({
					active: true,
					round: 1,
					malice: 3,
				});
				expect(
					must(before.bands[1]).combatants.map((c) => [c.id, c.acting, c.mine])
				).toEqual([
					["brann", false, true],
					["kesh", false, false],
					["bandit-cutpurse-a", true, false],
					["bandit-chief", false, false],
				]);
				yield* table.stop;
				table = yield* hostTable(dir);
				expect(yield* projection(table, everyone)).toEqual(before);

				const port2 = table.port;
				expect(yield* asGm(table, "/end")).toEqual([
					"Combat ends. Heroic resources, surges and Malice are lost; temporary Stamina and conditions end.",
				]);
				expect(yield* asPlayer(port2, bob, "hello")).toBe(
					"Bob (Kesh): hello\n"
				);
				const after = yield* projection(table, everyone);
				expect(after.bands[0]).toMatchObject({ active: false });
				expect(must(after.bands[0]).combatants.map((c) => c.name)).toEqual([
					"Brann (Alice)",
					"Kesh (Bob)",
				]);
				yield* table.stop;
				table = yield* hostTable(dir);
				expect(yield* projection(table, everyone)).toEqual(after);
				yield* table.stop;
			}),
		60_000
	);
});
