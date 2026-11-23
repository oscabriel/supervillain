import { describe, expect, test } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";
import { DateTime } from "effect";

import { ChatPosted, NameSet, Retracted } from "../src/events/core.ts";
import {
	DsDamaged,
	DsHeroClaimed,
	DsHeroJoined,
	DsMaliceChanged,
} from "../src/events/drawSteel.ts";
import { readLog } from "../src/readLog.ts";
import type { TableEvent } from "../src/Table.aggregate.ts";
import { envelopeOf } from "../src/Table.aggregate.ts";
import { effect } from "./effect.ts";
import { ALICE, GM, story, table, VEX } from "./fixtures.ts";

const { advance, given, state } = Story;

const START = DateTime.toEpochMillis(
	DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
);

const lineOf = (event: TableEvent, seq: number): string => {
	const at = DateTime.formatIso(DateTime.makeUnsafe(START + (seq - 1) * 1000));
	const { actor, type, payload, timestamp } = envelopeOf(event, seq, at);

	return JSON.stringify({ actor, seq, timestamp, type, payload });
};

const HISTORY: ReadonlyArray<TableEvent> = [
	new NameSet({ actor: ALICE, name: "Alice" }),
	new DsHeroJoined({ actor: GM, sheet: VEX }),
	new DsHeroClaimed({ actor: ALICE, hero: "vex", player: ALICE }),
	new DsMaliceChanged({ actor: GM, by: 3 }),
	new DsDamaged({ actor: GM, id: "vex", amount: 5, dealt: 5 }),
	new ChatPosted({ actor: ALICE, text: "ouch", style: "emote" }),
	new Retracted({
		actor: GM,
		seqs: [5],
		undone: ["Vex takes 5 damage → 16/21"],
	}),
];

const LINES = HISTORY.map((event, i) => lineOf(event, i + 1));

describe("a lenient read of the log", () => {
	effect("folds the same history to the very state the table holds", () =>
		story(
			...HISTORY.flatMap((event) => [given(table, event), advance("1 second")]),
			state(table, (folded) => {
				const read = readLog(LINES);

				expect(read.skipped).toEqual([]);
				expect(read.error).toBeUndefined();
				expect(read.state).toEqual(folded);
				expect(read.feed.map((l) => l.text)).toEqual([
					"Alice joins the table.",
					"Vex joins the party: Censor 1, 21 Stamina.",
					"takes Vex.",
					"Malice +3 → 3.",
					"Vex takes 5 damage → 16/21",
					"ouch",
					"undid: Vex takes 5 damage → 16/21",
				]);
			})
		)
	);

	test("skips what it can't read, saying why, and folds the rest", () => {
		const lines = [
			...LINES.slice(0, 4),
			"this is not json",
			JSON.stringify({
				actor: GM,
				seq: 5,
				timestamp: "2026-01-01T00:00:04.000Z",
				type: "ds.future-thing",
				payload: {},
			}),
			JSON.stringify({
				actor: GM,
				seq: 6,
				timestamp: "2026-01-01T00:00:05.000Z",
				type: "ds.malice-changed",
				payload: { by: "lots" },
			}),
			JSON.stringify({
				actor: GM,
				seq: 7,
				timestamp: "yesterday-ish",
				type: "ds.malice-changed",
				payload: { by: 1 },
			}),
		];

		const read = readLog(lines);

		expect(read.error).toBeUndefined();
		expect(read.skipped.map((s) => [s.line, s.seq, s.type])).toEqual([
			[5, undefined, undefined],
			[6, 5, "ds.future-thing"],
			[7, 6, "ds.malice-changed"],
			[8, 7, "ds.malice-changed"],
		]);
		expect(read.skipped[1]?.reason).toBe(
			'unknown event type "ds.future-thing"'
		);
		expect(read.skipped[3]?.reason).toBe(
			"timestamp yesterday-ish is not a time"
		);
		expect(read.state.ds.malice).toBe(3);
		expect(read.state.seq).toBe(6);
		expect(read.state.undo.at(-2)?.loose).toEqual([5]);
		expect(read.state.undo.at(-1)?.loose).toEqual([6]);
	});

	test("halts on an event it knows but can't fold, keeping what came before", () => {
		const read = readLog([
			...LINES.slice(0, 2),
			lineOf(new Retracted({ actor: GM, seqs: [9], undone: [] }), 3),
		]);

		expect(read.error).toEqual({
			line: 3,
			seq: 3,
			message:
				"the retraction at seq 3 names no batch that can be undone (seq 9)",
		});
		expect(read.state.seq).toBe(2);
		expect(read.feed).toHaveLength(2);
	});

	test("an empty log is a fresh table", () => {
		const read = readLog([]);

		expect(read.state.seq).toBe(0);
		expect(read.feed).toEqual([]);
		expect(read.skipped).toEqual([]);
	});
});
