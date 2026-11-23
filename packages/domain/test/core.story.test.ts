import { describe, expect } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";

import {
	Emote,
	Narrate,
	Redo,
	Roll,
	Say,
	SetName,
	Undo,
} from "../src/commands/core.ts";
import {
	DsMalice,
	DsDamage,
	DsResource,
	DsSetTemp,
	DsJoinHero,
	DsPlay,
	DsPowerRoll,
} from "../src/commands/drawSteel.ts";
import { diceOf } from "../src/Entropy.context.ts";
import {
	ChatPosted,
	DiceRolled,
	NameSet,
	Redone,
	Retracted,
} from "../src/events/core.ts";
import {
	DsDamaged,
	DsHeroClaimed,
	DsHeroJoined,
	DsMaliceChanged,
	DsPowerRolled,
	DsResourceChanged,
	DsTempSet,
} from "../src/events/drawSteel.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { feedLines, plainText, tableLabel } from "../src/table.ts";
import type { TableState } from "../src/table.ts";
import { effect } from "./effect.ts";
import {
	ALICE,
	as,
	BOB,
	GM,
	GUEST,
	KOR,
	seeded,
	seedRolling,
	story,
	table,
	VEX,
} from "./fixtures.ts";

const { advance, given, rejected, state, then, when } = Story;

const feedOf = (s: TableState): ReadonlyArray<string> =>
	feedLines(s, tableLabel(s, "draw-steel")).map(plainText);

const lastLine = (line: string) =>
	state(table, (s) => {
		expect(feedOf(s).at(-1)).toBe(line);
	});

const refused = (message: string) => rejected(new Refused({ message }));

const asGm = as(GM);

describe("chat", () => {
	effect(
		"plain chat, an emote and the GM's narration each read their own way",
		() =>
			story(
				seeded(1),
				as(ALICE),
				when(table, new Say({ text: "  hello   there " })),
				then(table, new ChatPosted({ actor: ALICE, text: "hello there" })),
				when(table, new Emote({ text: "waves" })),
				then(
					table,
					new ChatPosted({ actor: ALICE, text: "waves", style: "emote" })
				),
				asGm,
				when(table, new Narrate({ text: "Rain falls." })),
				then(
					table,
					new ChatPosted({ actor: GM, text: "Rain falls.", style: "narration" })
				),
				state(table, (s) => {
					expect(feedOf(s)).toEqual([
						"abcdefgh: hello there",
						"abcdefgh waves",
						"Rain falls.",
					]);
				})
			)
	);

	effect("refuses nothing to say, too much, and a player's narration", () =>
		story(
			seeded(1),
			as(ALICE),
			when(table, new Say({ text: " \u0007 " })),
			refused("Say something."),
			when(table, new Say({ text: "x".repeat(501) })),
			refused("Keep it to 500 characters (that was 501)."),
			when(table, new Narrate({ text: "I am the GM now." })),
			refused("Only the GM can use /narrate."),
			then(table)
		)
	);

	effect("terminal escapes never reach the feed", () =>
		story(
			seeded(1),
			as(BOB),
			when(table, new Say({ text: "\u001B[31mred\u001B[0m \u009B2Jalert" })),
			then(table, new ChatPosted({ actor: BOB, text: "red alert" }))
		)
	);
});

describe("names", () => {
	effect(
		"a first name joins the table; a second renames, relabelling the feed",
		() =>
			story(
				seeded(1),
				as(ALICE),
				when(table, new Say({ text: "hi" })),
				then(table, new ChatPosted({ actor: ALICE, text: "hi" })),
				when(table, new SetName({ name: "Alice" })),
				then(table, new NameSet({ actor: ALICE, name: "Alice" })),
				when(table, new SetName({ name: "Al" })),
				then(table, new NameSet({ actor: ALICE, name: "Al" })),
				state(table, (s) => {
					expect(feedOf(s)).toEqual([
						"Al: hi",
						"Alice joins the table.",
						"Alice is now Al",
					]);
				}),
				when(table, new SetName({ name: "Al" })),
				refused("You're already Al.")
			)
	);

	effect(
		"a name taken by someone else, or drawn to look like it, is refused",
		() =>
			story(
				given(table, new NameSet({ actor: ALICE, name: "Alice" })),
				seeded(1),
				as(BOB),
				when(table, new SetName({ name: "ALICE" })),
				refused('"ALICE" is taken; pick another name.'),
				when(table, new SetName({ name: "Аlice" })),
				refused("Names can't mix Latin letters with another script's."),
				when(table, new SetName({ name: "AIice" })),
				refused('"AIice" is taken; pick another name.'),
				when(table, new SetName({ name: "Bob (GM)" })),
				refused('"Bob (GM)" would read like a marker; pick another name.'),
				when(table, new SetName({ name: "guest-1234" })),
				refused('"guest-1234" looks like a guest\'s label; pick another name.'),
				when(table, new SetName({ name: "GM" })),
				refused('"GM" is taken; pick another name.'),
				when(table, new SetName({ name: "B​ob" })),
				refused("Names can't hold control or invisible characters."),
				then(table)
			)
	);

	effect("a guest's name is held only while the guest is seated", () =>
		story(
			given(table, new NameSet({ actor: GUEST, name: "Wren" })),
			seeded(1),
			as(ALICE),
			when(table, new SetName({ name: "Wren", seated: [GUEST] })),
			refused('"Wren" is taken; pick another name.'),
			when(table, new SetName({ name: "Wren", seated: [] })),
			then(table, new NameSet({ actor: ALICE, name: "Wren" }))
		)
	);

	effect("a name in play is taken: no line may read as a hero's", () =>
		story(
			seeded(1),
			as(ALICE),
			when(table, new SetName({ name: "vex", cast: ["Vex"] })),
			refused('"vex" is taken; pick another name.'),
			then(table)
		)
	);
});

describe("dice", () => {
	const seed = 41;
	const dice = diceOf(seed);
	const rolls = [dice(10), dice(10)];
	const [first = 0, second = 0] = rolls;

	effect("a roll carries its faces, so replay never rolls", () =>
		story(
			seeded(seed),
			as(BOB),
			when(table, new Roll({ notation: "2d10+3" })),
			then(
				table,
				new DiceRolled({
					actor: BOB,
					notation: "2d10+3",
					rolls,
					modifier: 3,
					total: first + second + 3,
				})
			),
			lastLine(
				`Zyxwvuts rolled 2d10+3: [${first}, ${second}] +3 = ${first + second + 3}`
			)
		)
	);

	effect("notation the table can't roll is refused", () =>
		story(
			seeded(seed),
			as(BOB),
			when(table, new Roll({ notation: "0d6" })),
			refused("Roll 1 to 100 dice at a time."),
			when(table, new Roll({ notation: "1d1" })),
			refused("Dice have 2 to 1000 sides."),
			when(table, new Roll({ notation: "fish" })),
			refused('"fish" isn\'t dice; try 2d10+3, d20 or 3d6-1.'),
			then(table)
		)
	);
});

const malice = (by: number) => new DsMaliceChanged({ actor: GM, by });

const vexJoins = new DsHeroJoined({ actor: GM, sheet: VEX });

const korJoins = new DsHeroJoined({ actor: GM, sheet: KOR });

const aliceTakesVex = new DsHeroClaimed({
	actor: ALICE,
	hero: "vex",
	player: ALICE,
});

describe("undo", () => {
	effect("the GM takes back the latest change, and the feed says so", () =>
		story(
			seeded(1),
			asGm,
			when(table, new DsMalice({ by: 2 })),
			then(table, malice(2)),
			when(table, new Undo({})),
			then(
				table,
				new Retracted({ actor: GM, seqs: [1], undone: ["Malice +2 → 2."] })
			),
			state(table, (s) => {
				expect(s.ds.malice).toBe(0);
				expect(feedOf(s)).toEqual([
					"Malice +2 → 2.",
					"↶ GM undid: Malice +2 → 2.",
				]);
				expect(s.redo).toHaveLength(1);
			}),
			when(table, new Redo({})),
			then(table, new Redone({ actor: GM, seqs: [1] })),
			state(table, (s) => {
				expect(s.ds.malice).toBe(2);
				expect(feedOf(s).at(-1)).toBe("↷ GM redid: Malice +2 → 2.");
			}),
			when(table, new Redo({})),
			refused("Nothing to redo.")
		)
	);

	effect("holds twenty batches; the oldest falls off", () =>
		story(
			...Array.from({ length: 21 }, () => [
				given(table, malice(1)),
				advance("1 second"),
			]).flat(),
			seeded(1),
			asGm,
			...Array.from({ length: 20 }, (_, n) => [
				when(table, new Undo({})),
				then(
					table,
					new Retracted({
						actor: GM,
						seqs: [21 - n],
						undone: [`Malice +1 → ${21 - n}.`],
					})
				),
			]).flat(),
			when(table, new Undo({})),
			refused("Nothing to undo."),
			state(table, (s) => {
				expect(s.ds.malice).toBe(1);
			})
		)
	);

	effect("a player takes back their own latest change within 30 seconds", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			advance("1 second"),
			seeded(1),
			as(ALICE),
			when(table, new DsResource({ who: "vex", by: 2 })),
			then(table, new DsResourceChanged({ actor: ALICE, id: "vex", by: 2 })),
			advance("29 seconds"),
			when(table, new Undo({})),
			then(
				table,
				new Retracted({
					actor: ALICE,
					seqs: [3],
					undone: ["Vex gains 2 Wrath → 2."],
				})
			),
			when(table, new DsResource({ who: "vex", by: 1 })),
			then(table, new DsResourceChanged({ actor: ALICE, id: "vex", by: 1 })),
			advance("31 seconds"),
			when(table, new Undo({})),
			refused(
				"Too late: you can take back your own change for 30 seconds. Ask the GM."
			),
			as(BOB),
			when(table, new Undo({})),
			refused("Only the GM can take back someone else's change."),
			asGm,
			when(table, new Undo({ who: "abcdefgh", whose: ALICE })),
			then(
				table,
				new Retracted({
					actor: GM,
					seqs: [5],
					undone: ["Vex gains 1 Wrath → 1."],
				})
			),
			when(table, new Undo({ who: "Zed" })),
			refused("Nobody at the table is called 'Zed'.")
		)
	);

	effect("a player never takes back a change that rolled dice", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			advance("1 second"),
			seeded(seedRolling([10, 3], [10, 4])),
			as(ALICE),
			when(
				table,
				new DsPowerRoll({ who: "vex", edges: 0, banes: 0, bonus: 1 })
			),
			then(
				table,
				new DsPowerRolled({
					actor: ALICE,
					id: "vex",
					dice: [3, 4],
					bonus: 1,
					edges: 0,
					banes: 0,
					total: 8,
					tier: 1,
				})
			),
			when(table, new Undo({})),
			refused("That change rolled dice, so only the GM can take it back.")
		)
	);

	effect("refuses to take back a change a later one depends on", () =>
		story(
			given(table, vexJoins),
			advance("1 second"),
			given(table, korJoins),
			advance("1 second"),
			given(table, aliceTakesVex),
			advance("1 second"),
			given(
				table,
				new DsDamaged({ actor: GM, id: "vex", amount: 10, dealt: 10 })
			),
			advance("1 second"),
			seeded(1),
			as(ALICE),
			when(table, new DsSetTemp({ who: "vex", amount: 5 })),
			then(table, new DsTempSet({ actor: ALICE, id: "vex", temp: 5 })),
			advance("1 second"),
			asGm,
			when(table, new DsDamage({ who: "vex", amount: 6 })),
			then(table, new DsDamaged({ actor: GM, id: "vex", amount: 6, dealt: 6 })),
			lastLine("Vex takes 6 damage (5 to temporary Stamina) → 10/21 · winded"),
			as(ALICE),
			when(table, new Undo({})),
			refused(
				'A later change depends on it: GM\'s "Vex takes 6 damage (5 to temporary Stamina) → 10/21 · winded". Undo that first, or ask the GM.'
			),
			state(table, (s) => {
				expect(s.ds.heroes[0]).toMatchObject({ stamina: 10, temp: 0 });
			})
		)
	);

	effect("a claim is never undone, and stands when a change before it is", () =>
		story(
			seeded(1),
			asGm,
			when(table, new DsJoinHero({ hero: "vex", sheet: VEX })),
			then(table, vexJoins),
			advance("1 second"),
			as(ALICE),
			when(table, new DsPlay({ hero: "vex", seated: [ALICE] })),
			then(table, aliceTakesVex),
			advance("1 second"),
			when(table, new Undo({})),
			refused("Only the GM can take back someone else's change."),
			asGm,
			when(table, new DsJoinHero({ hero: "kor", sheet: KOR })),
			then(table, korJoins),
			when(table, new Undo({})),
			then(
				table,
				new Retracted({
					actor: GM,
					seqs: [3],
					undone: ["Kor joins the party: Fury 1, 24 Stamina."],
				})
			),
			state(table, (s) => {
				expect(s.ds.heroes.map((h) => [h.id, h.player])).toEqual([
					["vex", ALICE],
				]);
			})
		)
	);
});
