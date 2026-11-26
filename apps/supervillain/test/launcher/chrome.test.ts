import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Cause, Effect, Exit, Fiber, Option } from "effect";

import { banner, cut, fitRow, rowWidth } from "../../src/chrome/frame.ts";
import type { NavRules, NavState } from "../../src/chrome/keys.ts";
import { readKeys } from "../../src/chrome/read.ts";
import { launcherFrame } from "../../src/launcher/frame.ts";
import { launching } from "../../src/launcher/keys.ts";
import type { FoundCampaign } from "../../src/launcher/scan.ts";
import { effect, waitFor } from "../host/effect.ts";

const FAMILY = "👩‍👩‍👧‍👦";

const found = (name: string, here: boolean): FoundCampaign => ({
	dir: `/home/gm/テーブル置き場/${name}`,
	name,
	rules: "draw-steel",
	here,
	lastPlayed: Option.none(),
});

describe("the chrome's text fitting", () => {
	test("a cut counts terminal cells, not code points", () => {
		expect(cut("日本語テーブル名前", 6)).toBe("日本…");
		expect(cut("日本語", 6)).toBe("日本語");
		expect(cut("日本語", 5)).toBe("日本…");
		expect(cut("🎲🎲🎲🎲🎲", 5)).toBe("🎲🎲…");
		expect(cut(`${FAMILY}${FAMILY}${FAMILY}`, 5)).toBe(`${FAMILY}${FAMILY}…`);
		expect(cut("ééééé", 4)).toBe("ééé…");
		expect(cut("plain ascii name", 8)).toBe("plain a…");
		expect(cut("fits", 4)).toBe("fits");
		expect(cut("abc", 0)).toBe("…");

		for (const text of [
			"日本語テーブル名前",
			"🎲 dice night 🎲🎲🎲",
			`${FAMILY} family table ${FAMILY}${FAMILY}`,
			"mixed 日本語 and ascii",
		]) {
			for (let budget = 1; budget <= 24; budget += 1) {
				expect(Bun.stringWidth(cut(text, budget))).toBeLessThanOrEqual(budget);
			}
		}
	});

	test("a row is fitted to its column in cells", () => {
		const row = [{ text: "ab" }, { text: "日本語テーブル名前" }, { text: "x" }];

		for (let max = 1; max <= 22; max += 1) {
			expect(rowWidth(fitRow(row, max))).toBeLessThanOrEqual(max);
		}

		expect(fitRow(row, 7)).toEqual([{ text: "ab" }, { text: "日本…" }]);
	});

	test("a table folder named in CJK or emoji never widens the launcher's frame", () => {
		const campaigns = [
			found(
				"日本語のとても長いキャンペーンフォルダ名前です日本語のとても長い名前",
				true
			),
			found(
				"🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲🎲",
				false
			),
			found("keep", false),
		];

		for (const [cols, rows] of [
			[60, 20],
			[80, 24],
			[100, 30],
			[140, 40],
		] as const) {
			for (const tab of ["tables", "session"] as const) {
				for (const picked of [0, 1, 2]) {
					const state = launching(false);
					state.tab = tab;
					state.picked = picked;

					const frame = launcherFrame(
						{
							state,
							campaigns,
							home: "/home/gm/テーブル置き場/とても長いホームフォルダ名前/さらに長い名前",
							handle: undefined,
							relay: undefined,
							term: "xterm-256color",
							now: 0,
						},
						cols,
						rows
					);

					const lines = Bun.stripANSI(
						frame.slice("\u001B[H\u001B[2J".length)
					).split("\r\n");

					expect(lines.length).toBeLessThanOrEqual(rows);

					for (const line of lines) {
						expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
					}
				}
			}
		}
	});

	test("the title is drawn once per width tier, not on every frame", () => {
		expect(banner(112)).toBe(banner(200));
		expect(banner(88)).toBe(banner(111));
		expect(banner(50)).toBe(banner(87));
		expect(banner(49)).toBe(banner(10));
		expect(banner(49)).toEqual([]);
		expect(banner(200).length).toBeGreaterThan(banner(60).length);
		expect(banner(111)).not.toBe(banner(112));
	});
});

interface Typing extends NavState {
	backedOut: number;
}

const typing = (): Typing => ({
	tab: "tables",
	picked: 0,
	editing: false,
	said: undefined,
	escape: "no",
	sequence: "",
	afterCr: false,
	backedOut: 0,
});

const RULES: NavRules<Typing> = {
	switchTab: (state, tab) => {
		state.tab = tab;
	},
	backOut: (state) => {
		state.backedOut += 1;

		return true;
	},
	sideways: () => false,
};

const ESC = 0x1b;

const reading = (onDraw: () => void) => {
	const stream = new PassThrough();
	const state = typing();
	const redraws: Array<boolean> = [];

	const read = readKeys({
		stream,
		state,
		rules: RULES,
		keyed: (_chunk, at, byte) => {
			if (byte === ESC) {
				state.escape = "esc";
			}

			return byte === 0x58 ? { result: "picked", rest: at + 1 } : undefined;
		},
		ended: "ended",
		idle: { ms: 60_000, result: "idle" },
		draw: onDraw,
		redraw: (again) => {
			redraws.push(again !== undefined);
		},
	});

	return { stream, state, redraws, read };
};

const listening = (stream: PassThrough) =>
	stream.listenerCount("data") + stream.listenerCount("end");

describe("the chrome's key reader", () => {
	effect("a pick ends it, hands back what was typed after, and lets go", () =>
		Effect.gen(function* () {
			let drawn = 0;

			const { stream, redraws, read } = reading(() => {
				drawn += 1;
			});

			const fiber = yield* Effect.forkChild(read);
			yield* waitFor("the first frame", () => drawn === 1);
			stream.write("ab");
			yield* waitFor("a redraw", () => drawn === 2);
			stream.write("cXrest");
			expect(yield* Fiber.join(fiber)).toBe("picked");
			const rest: unknown = stream.read();
			expect(Buffer.isBuffer(rest) && rest.toString("utf-8")).toBe("rest");
			expect(listening(stream)).toBe(0);
			expect(redraws).toEqual([true, false]);
		})
	);

	effect("the stream ending ends it", () =>
		Effect.gen(function* () {
			let drawn = 0;

			const { stream, read } = reading(() => {
				drawn += 1;
			});

			const fiber = yield* Effect.forkChild(read);
			yield* waitFor("the first frame", () => drawn === 1);
			stream.end();
			expect(yield* Fiber.join(fiber)).toBe("ended");
			expect(listening(stream)).toBe(0);
		})
	);

	effect("a lone Esc backs out once no sequence follows it", () =>
		Effect.gen(function* () {
			let drawn = 0;

			const { stream, state, read } = reading(() => {
				drawn += 1;
			});

			const fiber = yield* Effect.forkChild(read);
			yield* waitFor("the first frame", () => drawn === 1);
			stream.write("\u001B");
			yield* waitFor("the Esc to flush", () => state.backedOut === 1);
			expect(state.escape).toBe("no");
			yield* waitFor("the redraw", () => drawn === 3);
			yield* Fiber.interrupt(fiber);
		})
	);

	effect("a throw while drawing fails the read instead of escaping it", () =>
		Effect.gen(function* () {
			let drawn = 0;

			const { stream, redraws, read } = reading(() => {
				drawn += 1;

				if (drawn === 2) {
					throw new Error("the frame broke");
				}
			});

			const fiber = yield* Effect.forkChild(read);
			yield* waitFor("the first frame", () => drawn === 1);
			stream.write("a");
			const exit = yield* Fiber.await(fiber);
			expect(Exit.hasDies(exit)).toBe(true);
			expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
				"the frame broke"
			);
			expect(listening(stream)).toBe(0);
			expect(redraws).toEqual([true, false]);
		})
	);

	effect("a throw on the first frame fails the read too", () =>
		Effect.gen(function* () {
			const { stream, read } = reading(() => {
				throw new Error("no frame at all");
			});

			const exit = yield* Effect.exit(read);
			expect(Exit.hasDies(exit)).toBe(true);
			expect(listening(stream)).toBe(0);
		})
	);

	effect("interrupted, it lets go of the stream", () =>
		Effect.gen(function* () {
			let drawn = 0;

			const { stream, redraws, read } = reading(() => {
				drawn += 1;
			});

			const fiber = yield* Effect.forkChild(read);
			yield* waitFor("the first frame", () => drawn === 1);
			expect(listening(stream)).toBe(2);
			yield* Fiber.interrupt(fiber);
			expect(listening(stream)).toBe(0);
			expect(redraws).toEqual([true, false]);
		})
	);
});
