import { describe, expect, test } from "bun:test";

import {
	feedLines,
	parseInputLine,
	plainText,
	rules,
	tableLabel,
	withHostFact,
} from "@supervillain/domain";
import type { Command, Envelope } from "@supervillain/domain";

import { KOR, VEX } from "../drawSteel/harness.ts";
import { fold, throughJson } from "./fold.ts";
import { must } from "./must.ts";
import { ALICE, BOB, env, GM, START, Table } from "./table.ts";

const undo = { type: "undo" } as const;

const redo = { type: "redo" } as const;

const at = (seconds: number) =>
	new Date(Date.parse(START) + seconds * 1000).toISOString();

const line = (typed: string): Command => {
	const parsed = parseInputLine(typed, "chat", "draw-steel");

	if (parsed.kind !== "command") {
		throw new Error(`${typed} isn't a command: ${JSON.stringify(parsed)}`);
	}

	return parsed.command;
};

const party = () => {
	const t = new Table();
	t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
	t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
	t.run(ALICE, line("/play vex"));
	t.run(BOB, line("/play kor"));
	t.run(ALICE, line("/name Alice"));
	t.run(BOB, line("/name Bob"));

	return t;
};

const vex = (t: Table) => t.state.ds.heroes.find((h) => h.id === "vex");

const kor = (t: Table) => t.state.ds.heroes.find((h) => h.id === "kor");

const submission = (
	t: Table,
	actor: string,
	events: ReadonlyArray<readonly [string, object]>
) => {
	const timestamp = t.now;

	for (const [type, payload] of events) {
		t.envelopes.push(
			env(t.envelopes.length + 1, type, payload, actor, timestamp)
		);
	}

	t.wait(1);
};

const batches = (...log: ReadonlyArray<Envelope>) =>
	fold(rules, log, { strict: true }).state.undo.map((b) => b.seqs);

const halted = (...log: ReadonlyArray<Envelope>) =>
	fold(rules, log, { strict: true }).error;

describe("undo, in the rules and the fold", () => {
	test("takes back the latest batch whole, restoring the slice from before it, newest first", () => {
		const t = party();
		t.run(GM, line("/malice +5"));
		submission(t, ALICE, [
			["ds.resource-changed", { id: "vex", by: 2 }],
			["ds.resource-changed", { id: "vex", by: 3 }],
		]);
		expect(vex(t)?.resource).toBe(5);
		const seqs = [t.envelopes.length - 1, t.envelopes.length];

		t.run(GM, undo);
		expect(t.last).toMatchObject({
			actor: GM,
			type: "core.retracted",
			payload: {
				seqs,
				undone: ["Vex gains 2 Wrath → 2.", "Vex gains 3 Wrath → 5."],
			},
		});
		expect(vex(t)?.resource).toBe(0);
		expect(t.state.ds.malice).toBe(5);

		t.run(GM, undo);
		expect(t.state.ds.malice).toBe(0);
		t.run(GM, undo);
		t.run(GM, undo);
		expect(t.state.ds.heroes).toEqual([]);
		expect(t.submit(GM, undo)).toBe("Nothing to undo.");
		expect(t.envelopes.map((e) => e.type).slice(-7)).toEqual([
			"ds.malice-changed",
			"ds.resource-changed",
			"ds.resource-changed",
			"core.retracted",
			"core.retracted",
			"core.retracted",
			"core.retracted",
		]);
	});

	test("a log with a retraction in it replays to the same state, without decide", () => {
		const t = party();
		t.run(GM, line("/malice +5"));
		t.run(ALICE, line("/res vex +2"));
		t.run(ALICE, line("oops"));
		t.run(GM, undo);

		const log = throughJson(t.envelopes);

		const folded = fold(rules, log, { strict: true });
		expect(folded.error).toBeUndefined();
		expect(folded.state.ds.malice).toBe(5);
		expect(folded.state.ds.heroes.map((h) => h.resource)).toEqual([0, 0]);
		expect(folded.state.feed.slice(-4).map((e) => [e.kind, e.text])).toEqual([
			["ds", "Malice +5 → 5."],
			["ds", "Vex gains 2 Wrath → 2."],
			["chat", "oops"],
			["undo", "undid: Vex gains 2 Wrath → 2."],
		]);
		let live = rules.initial;

		for (const e of t.envelopes) {
			live = rules.apply(live, e);
		}

		expect(folded.state).toEqual(live);
		expect(folded.state.undo.at(-1)?.seqs).toEqual([
			t.envelopes.findIndex((e) => e.type === "ds.malice-changed") + 1,
		]);
	});

	test("the stack holds 20 batches; the oldest falls off", () => {
		const t = new Table();

		for (let i = 0; i < 21; i += 1) {
			t.run(GM, line("/malice +1"));
		}

		expect(t.state.undo).toHaveLength(20);

		for (let i = 0; i < 20; i += 1) {
			t.run(GM, undo);
		}

		expect(t.state.ds.malice).toBe(1);
		expect(t.submit(GM, undo)).toBe("Nothing to undo.");
	});

	test("events that aren't retractable stay put, in any slice, and the feed keeps every line", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(GM, line("/malice +5"));
		t.run(ALICE, line("nice"));
		t.run(ALICE, line("/name Wren"));
		t.run(ALICE, line("/roll 1d6"), () => 4);
		t.run(ALICE, line("/play vex"));
		t.run(GM, undo);
		expect(t.state.ds.malice).toBe(0);
		expect(vex(t)?.player).toBe(ALICE);
		expect(t.state.core).toEqual({ names: { [ALICE]: "Wren" } });
		const texts = t.state.feed.map((e) => e.text);
		expect(texts.slice(1, 5)).toEqual([
			"Malice +5 → 5.",
			"nice",
			"Wren joins the table.",
			"rolled 1d6: [4] = 4",
		]);
		expect(texts).toHaveLength(7);
		expect(texts.at(-1)).toBe("undid: Malice +5 → 5.");
	});

	test("a batch is the retractable events of one submission: one actor, one timestamp, unbroken", () => {
		expect(
			batches(
				env(1, "ds.malice-changed", { by: 1 }, GM),
				env(2, "ds.tokens-changed", { by: 1 }, ALICE)
			)
		).toEqual([[1], [2]]);
		expect(
			batches(
				env(1, "ds.hero-joined", { sheet: VEX }),
				env(2, "ds.hero-claimed", { hero: "vex", player: ALICE }),
				env(3, "ds.malice-changed", { by: 1 })
			)
		).toEqual([[1], [3]]);
		expect(
			batches(
				env(1, "ds.malice-changed", { by: 1 }),
				env(2, "ds.malice-changed", { by: 1 })
			)
		).toEqual([[1, 2]]);
	});

	test("a retraction of no batch on the stack, or of one a later batch depends on, halts replay", () => {
		expect(
			halted(
				env(1, "ds.malice-changed", { by: 1 }, GM, at(0)),
				env(2, "ds.malice-changed", { by: 1 }, GM, at(1)),
				env(3, "core.retracted", { seqs: [1, 2], undone: [] }, GM, at(2))
			)
		).toEqual({
			seq: 3,
			message:
				"the retraction at seq 3 names no batch that can be undone (seq 1, 2)",
		});

		const broken = halted(
			env(1, "ds.hero-joined", { sheet: VEX }, GM, at(0)),
			env(2, "ds.damaged", { id: "vex", amount: 3, dealt: 3 }, GM, at(1)),
			env(3, "core.retracted", { seqs: [1], undone: [] }, GM, at(2))
		);

		expect(broken?.seq).toBe(3);
		expect(broken?.message).toStartWith(
			"the retraction at seq 3 would break a later change: "
		);
		expect(
			halted(
				env(1, "ds.malice-changed", { by: 1 }, GM, at(0)),
				env(2, "ds.malice-changed", { by: 1 }, ALICE, at(1)),
				env(
					3,
					"core.retracted",
					{ seqs: [1], undone: ["Malice +1 → 1."] },
					GM,
					at(2)
				)
			)
		).toEqual({
			seq: 3,
			message:
				'the retraction at seq 3 would change a later change at seq 2: "Malice +1 → 2." would read "Malice +1 → 1."',
		});
		expect(halted(env(1, "core.retracted", { seqs: [1], undone: [] }))).toEqual(
			{
				seq: 1,
				message: "the retraction at seq 1 has nothing to take back",
			}
		);
	});
});

describe("a player's undo", () => {
	test("takes back their own latest batch within 30 seconds", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		t.run(BOB, line("chat doesn't count"));
		t.wait(28);
		t.run(ALICE, undo);
		expect(vex(t)?.resource).toBe(0);
	});

	test("not after 30 seconds, though the GM still can", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		t.wait(30);
		expect(t.submit(ALICE, undo)).toBe(
			"Too late: you can take back your own change for 30 seconds. Ask the GM."
		);
		t.run(GM, undo);
		expect(vex(t)?.resource).toBe(0);
	});

	test("only their own: their latest batch, even with someone else's after it", () => {
		const t = new Table();
		expect(t.submit(ALICE, undo)).toBe("Nothing to undo.");
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		expect(t.submit(ALICE, undo)).toBe(
			"Only the GM can take back someone else's change."
		);
		t.run(ALICE, line("/play vex"));
		t.run(BOB, line("/play kor"));
		t.run(ALICE, line("/res vex +2"));
		t.run(BOB, line("/res kor +1"));
		t.run(ALICE, undo);
		expect([vex(t)?.resource, kor(t)?.resource]).toEqual([0, 1]);
		expect(t.state.feed.at(-1)?.text).toBe("undid: Vex gains 2 Wrath → 2.");
		expect(t.state.undo.map((b) => b.actor)).toEqual([GM, GM, BOB]);
		t.run(GM, undo);
		expect(kor(t)?.resource).toBe(0);
	});

	test("naming nobody at the table is refused, as the GM's is, not taken as their own", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		expect(t.submit(ALICE, { type: "undo", who: "Zed" })).toBe(
			"Nobody at the table is called 'Zed'."
		);
		expect(vex(t)?.resource).toBe(2);
	});

	test("not when a later change depends on it; the GM takes that back first", () => {
		const t = party();
		t.run(ALICE, line("/temp vex 5"));
		t.run(GM, line("/dmg vex 6"));
		const hit = t.state.feed.at(-1)?.text;
		expect(t.submit(ALICE, undo)).toBe(
			`A later change depends on it: GM's "${hit}". Undo that first, or ask the GM.`
		);
		expect(t.submit(GM, { type: "undo", who: "Alice", whose: ALICE })).toBe(
			`A later change depends on it: GM's "${hit}". Undo that first.`
		);
		t.run(GM, undo);
		t.run(ALICE, undo);
		expect(vex(t)).toMatchObject({ stamina: 21, temp: 0 });
	});

	test("not when a later change would come out differently: its feed line would be wrong", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		t.run(GM, line("/res vex +1"));
		t.run(BOB, line("/res kor +1"));
		t.run(GM, line("/res vex +4"));
		const later = `GM's "Vex gains 1 Wrath → 3"; GM's "Vex gains 4 Wrath → 7"`;
		expect(t.submit(ALICE, undo)).toBe(
			`Later changes depend on it: ${later}. Undo those first, or ask the GM.`
		);
		expect(t.submit(GM, { type: "undo", who: "Alice", whose: ALICE })).toBe(
			`Later changes depend on it: ${later}. Undo those first.`
		);
		expect(t.envelopes.at(-1)?.type).toBe("ds.resource-changed");
		expect([vex(t)?.resource, kor(t)?.resource]).toEqual([7, 1]);
		t.run(GM, undo);
		t.run(GM, { type: "undo", who: "GM", whose: GM });
		t.run(ALICE, undo);
		expect([vex(t)?.resource, kor(t)?.resource]).toEqual([0, 1]);
	});

	test("never a batch that rolled dice: the GM's alone, so nobody rolls again by undoing", () => {
		const t = party();
		t.run(ALICE, line("/pr vex Spinning Strike"), () => 4);
		expect(t.submit(ALICE, undo)).toBe(
			"That change rolled dice, so only the GM can take it back."
		);
		t.run(GM, undo);
		expect(t.state.feed.at(-1)?.text).toStartWith(
			"undid: Vex uses Spinning Strike"
		);
	});

	test("a measurement or anything else that changes nothing never stands in the way", () => {
		const t = party();
		t.run(
			GM,
			withHostFact(line("/map field"), {
				kind: "map",
				id: "field",
				grid: { name: "Field", terrain: ["........", "........"] },
			})
		);
		t.run(GM, line("/place vex a1"));
		t.run(GM, line("/place kor c1"));
		t.run(ALICE, line("/res vex +2"));
		t.run(BOB, line("/dist vex kor"));
		t.run(ALICE, undo);
		expect(vex(t)?.resource).toBe(0);
		t.run(BOB, line("/dist vex kor"));

		const measured = t.envelopes
			.filter((e) => e.type === "ds.measured")
			.map((e) => e.seq);

		expect(measured).toHaveLength(2);
		expect(
			t.state.undo.flatMap((b) => b.seqs).filter((s) => measured.includes(s))
		).toEqual([]);
		t.run(GM, undo);
		expect(t.state.ds.map?.tokens.kor).toBeUndefined();
	});
});

describe("undo at the Draw Steel table", () => {
	test("a player can't change the result of a later change by taking back their own", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(GM, { type: "dmg", who: "vex", amount: 10 });
		t.run(ALICE, { type: "temp", who: "vex", amount: 5 });
		t.run(GM, { type: "dmg", who: "vex", amount: 6 });
		const hit = must(t.state.feed.at(-1)).text;
		expect(hit).toBe(
			"Vex takes 6 damage (5 to temporary Stamina) → 10/21 · winded"
		);
		expect(t.submit(ALICE, { type: "undo" })).toBe(
			`A later change depends on it: GM's "${hit}". Undo that first, or ask the GM.`
		);
		expect(t.state.ds.heroes[0]).toMatchObject({ stamina: 10, temp: 0 });
		t.run(GM, undo);
		t.run(GM, { type: "dmg", who: "kor", amount: 3 });
		t.run(ALICE, { type: "undo" });
		expect(t.state.ds.heroes.map((h) => [h.stamina, h.temp])).toEqual([
			[11, 0],
			[21, 0],
		]);
	});

	test("the feed says who undid what, in the undone lines' own words", () => {
		const t = new Table();
		t.run(GM, { type: "name", name: "Oscar" });
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(GM, { type: "dmg", who: "vex", amount: 14 });
		t.run(GM, undo);
		const { state } = t;
		expect(
			feedLines(state, tableLabel(state, "draw-steel")).map(plainText).slice(-2)
		).toEqual([
			"Vex takes 14 damage → 7/21 · winded",
			"↶ Oscar undid: Vex takes 14 damage → 7/21 · winded",
		]);
		expect(state.ds.heroes[0]?.stamina).toBe(21);
	});

	test("a claim is never undone, and undo can still go back past the hero's arrival", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(GM, {
			type: "hero",
			hero: "kor",
			sheet: { ...VEX, id: "kor", name: "Kor" },
		});
		t.run(GM, { type: "dmg", who: "vex", amount: 5 });
		t.run(ALICE, { type: "play", hero: "vex" });
		expect(t.state.undo).toHaveLength(3);
		t.run(GM, undo);
		expect(t.state.ds.heroes[0]).toMatchObject({ stamina: 21, player: ALICE });
		t.run(GM, undo);
		t.run(GM, undo);
		expect(t.state.ds.heroes).toEqual([]);
		expect(t.submit(GM, undo)).toBe("Nothing to undo.");
	});

	test("a claim stands when an older change is taken back, though its hero came later", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(ALICE, { type: "res", who: "vex", by: 1 });
		t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
		t.run(BOB, { type: "play", hero: "kor" });
		t.run(ALICE, { type: "undo" });
		expect(t.state.ds.heroes.map((h) => [h.id, h.resource, h.player])).toEqual([
			["vex", 0, ALICE],
			["kor", 0, BOB],
		]);
		t.run(GM, undo);
		expect(t.state.ds.heroes.map((h) => h.id)).toEqual(["vex"]);
		t.run(GM, redo);
		expect(t.state.ds.heroes.map((h) => [h.id, h.player])).toEqual([
			["vex", ALICE],
			["kor", BOB],
		]);
		t.run(GM, undo);
		t.run(GM, undo);
		expect(t.state.ds.heroes).toEqual([]);
	});

	test("the undone lines are joined without doubled stops", () => {
		const t = party();
		submission(t, ALICE, [
			["ds.resource-changed", { id: "vex", by: 2 }],
			["ds.resource-changed", { id: "vex", by: 3 }],
		]);
		t.run(GM, undo);
		expect(t.state.feed.at(-1)?.text).toBe(
			"undid: Vex gains 2 Wrath → 2; Vex gains 3 Wrath → 5."
		);
		t.run(GM, line("/malice +1"));
		t.run(GM, undo);
		expect(t.state.feed.at(-1)?.text).toBe("undid: Malice +1 → 1.");
	});
});

describe("redo", () => {
	test("puts back what the latest undo took, from the log, so its dice aren't rolled again", () => {
		const t = party();
		t.run(GM, line("/pr vex Spinning Strike"), () => 4);
		const rolled = t.envelopes.length;
		const said = t.state.feed.at(-1)?.text;
		t.run(GM, undo);
		t.run(GM, redo);
		expect(t.last).toMatchObject({
			type: "core.redone",
			payload: { seqs: [rolled] },
		});
		expect(t.state.feed.at(-1)?.text).toBe(`redid: ${said}`);
		t.run(GM, undo);
		t.run(GM, redo);
		expect(t.state.feed.at(-1)?.text).toBe(`redid: ${said}`);
		expect(t.submit(GM, redo)).toBe("Nothing to redo.");
	});

	test("walks forward through several undos, newest undo first", () => {
		const t = party();
		t.run(GM, line("/malice +5"));
		t.run(BOB, line("/res kor +1"));
		t.run(GM, undo);
		t.run(GM, undo);
		t.run(GM, redo);
		expect([t.state.ds.malice, kor(t)?.resource]).toEqual([5, 0]);
		t.run(GM, redo);
		expect([t.state.ds.malice, kor(t)?.resource]).toEqual([5, 1]);
	});

	test("a player redoes only an undo they did; any new change ends the redo", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		t.run(GM, undo);
		expect(t.submit(ALICE, redo)).toBe(
			"Only the GM can redo someone else's undo."
		);
		t.run(GM, redo);
		t.run(ALICE, undo);
		t.run(ALICE, redo);
		expect(vex(t)?.resource).toBe(2);
		t.run(ALICE, undo);
		t.run(BOB, line("/res kor +1"));
		expect(t.submit(ALICE, redo)).toBe("Nothing to redo.");
	});

	const changed = "That can't be put back now: the game has changed under it.";

	test("a redo that isn't of the latest undo halts replay", () => {
		expect(
			halted(
				env(1, "ds.malice-changed", { by: 5 }, GM, at(0)),
				env(
					2,
					"core.retracted",
					{ seqs: [1], undone: ["Malice +5 → 5."] },
					GM,
					at(1)
				),
				env(3, "ds.malice-changed", { by: 1 }, GM, at(2)),
				env(4, "core.redone", { seqs: [1] }, GM, at(3))
			)
		).toEqual({
			seq: 4,
			message: "the redo at seq 4 isn't of the latest undo",
		});
	});

	test("not once anything has changed since the undo; a log with such a redo still replays", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		const changedAt = t.envelopes.length;
		t.run(ALICE, undo);
		t.run(ALICE, line("/unplay"));
		t.run(BOB, line("/unplay"));
		t.run(BOB, line("/play vex"));
		expect(t.submit(ALICE, redo)).toBe(changed);

		const replayed = fold(
			rules,
			[
				...t.envelopes,
				env(
					t.envelopes.length + 1,
					"core.redone",
					{ seqs: [changedAt] },
					ALICE,
					at(99)
				),
			],
			{ strict: true }
		);

		expect(replayed.error).toBeUndefined();
		expect(replayed.state.ds.heroes[0]).toMatchObject({
			resource: 2,
			player: BOB,
		});
	});

	test("not of an older batch's undo: it would land on top of what came after it", () => {
		const t = party();
		t.run(ALICE, line("/res vex +2"));
		t.run(GM, line("/malice +1"));
		t.run(GM, { type: "undo", who: "Alice", whose: ALICE });
		expect(t.submit(GM, redo)).toBe(changed);
		expect([vex(t)?.resource, t.state.ds.malice]).toEqual([0, 1]);
	});

	test("at the Draw Steel table: undo, undo, redo, redo ends where it began", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(ALICE, { type: "res", who: "vex", by: 1 });
		t.run(GM, { type: "dmg", who: "vex", amount: 5 });
		const before = t.state.ds;
		t.run(GM, undo);
		t.run(GM, undo);
		expect(t.state.ds.heroes[0]).toMatchObject({
			stamina: 21,
			resource: 0,
			player: ALICE,
		});
		t.run(GM, redo);
		t.run(GM, redo);
		expect(t.state.ds).toEqual(before);
		expect(t.submit(GM, redo)).toBe("Nothing to redo.");
	});

	test("a player can't redo onto a hero that has changed hands since", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(ALICE, { type: "res", who: "vex", by: 1 });
		t.run(ALICE, { type: "undo" });
		t.run(ALICE, { type: "unplay" });
		t.run(BOB, { type: "play", hero: "vex" });
		expect(t.submit(ALICE, redo)).toBe(changed);
		expect(t.state.ds.heroes[0]).toMatchObject({ resource: 0, player: BOB });
	});

	test("an older change the GM took back isn't put back past decide: no condition on the dead", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(ALICE, {
			type: "cond",
			who: "vex",
			condition: "slowed",
			duration: "end",
		});
		t.run(GM, { type: "dmg", who: "vex", amount: 40 });
		t.run(GM, { type: "undo", who: "Alice", whose: ALICE });
		expect(t.submit(GM, redo)).toBe(changed);
		expect(t.state.ds.heroes[0]?.conditions).toEqual([]);
	});

	test("nor temporary Stamina lowered under a larger amount given since", () => {
		const t = new Table();
		t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
		t.run(ALICE, { type: "play", hero: "vex" });
		t.run(ALICE, { type: "temp", who: "vex", amount: 5 });
		t.run(GM, { type: "temp", who: "vex", amount: 9 });
		t.run(GM, { type: "undo", who: "Alice", whose: ALICE });
		expect(t.submit(GM, redo)).toBe(changed);
		expect(t.state.ds.heroes[0]?.temp).toBe(9);
	});
});

describe("a lenient reader", () => {
	test("takes back a batch that held an event it doesn't know", () => {
		const log = [
			env(1, "ds.malice-changed", { by: 5 }, GM, at(0)),
			env(2, "ds.malice-changed", { by: 2 }, ALICE, at(1)),
			env(3, "ds.future-thing", {}, ALICE, at(1)),
			env(
				4,
				"core.retracted",
				{ seqs: [2, 3], undone: ["Malice +2 → 7.", "?"] },
				GM,
				at(2)
			),
		];

		const folded = fold(rules, log, { strict: false });
		expect(folded.error).toBeUndefined();
		expect(folded.skipped.map((e) => e.seq)).toEqual([3]);
		expect(folded.state.ds.malice).toBe(5);
	});

	test("takes back a batch it knows nothing of, or one that began with such an event", () => {
		const log = [
			env(1, "ds.malice-changed", { by: 5 }, GM, at(0)),
			env(2, "ds.future-thing", {}, ALICE, at(1)),
			env(3, "core.retracted", { seqs: [2], undone: ["?"] }, GM, at(2)),
			env(4, "ds.future-thing", {}, ALICE, at(3)),
			env(5, "ds.malice-changed", { by: 2 }, ALICE, at(3)),
			env(
				6,
				"core.retracted",
				{ seqs: [4, 5], undone: ["?", "Malice +2 → 7."] },
				GM,
				at(4)
			),
		];

		const folded = fold(rules, log, { strict: false });
		expect(folded.error).toBeUndefined();
		expect(folded.skipped.map((e) => e.seq)).toEqual([2, 4]);
		expect(folded.state.ds.malice).toBe(5);
		expect(folded.state.undo.map((b) => b.seqs)).toEqual([[1]]);

		const redone = fold(
			rules,
			[...log, env(7, "core.redone", { seqs: [4, 5] }, GM, at(5))],
			{ strict: false }
		);

		expect(redone.error).toBeUndefined();
		expect(redone.state.ds.malice).toBe(7);
	});
});
