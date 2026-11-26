import { describe, expect, test } from "bun:test";

import {
	defaultLabel,
	FEED_LIMIT,
	feedLines,
	labelOf,
	nameOf,
	needsName,
	rules,
} from "@supervillain/domain";
import { Predicate } from "effect";

import { fold, throughJson } from "./fold.ts";
import { openRules } from "./open.ts";
import {
	ALICE,
	BOB,
	env,
	fixedDice,
	GM,
	GUEST,
	noDice,
	Table,
	START,
} from "./table.ts";

const feed = (table: Table) => {
	const { state } = table;

	return feedLines(state, labelOf(state));
};

describe("chat", () => {
	test("plain chat is posted as core.chat-posted and shows in the feed", () => {
		const table = new Table();
		expect(
			table.submit(ALICE, { type: "say", text: "hello table" })
		).toBeUndefined();
		expect(table.last?.type).toBe("core.chat-posted");
		expect(table.last?.payload).toEqual({ text: "hello table" });
		expect(feed(table)).toEqual([
			{ seq: 1, who: "abcdefgh", kind: "chat", text: "hello table", gm: false },
		]);
	});
});

const posted = (raw: string) => {
	const table = new Table();
	const refusal = table.submit(ALICE, { type: "say", text: raw });

	const payload: unknown = table.last?.payload;

	return (
		refusal ??
		(Predicate.hasProperty(payload, "text") && Predicate.isString(payload.text)
			? payload.text
			: undefined)
	);
};

describe("chat text", () => {
	test("pasted newlines and tabs become single spaces", () => {
		expect(posted("first line\r\nsecond\tline\n\nthird")).toBe(
			"first line second line third"
		);
	});

	test("ANSI escapes and control characters never reach the log", () => {
		expect(posted("\u001B[31mred\u001B[0m alert")).toBe("red alert");
		expect(posted("title\u001B]0;pwned\u0007 change")).toBe("title change");
		expect(posted("bell\u0007 and back\u0008space\u007F")).toBe(
			"bell and backspace"
		);
		expect(posted("c1\u009B2J csi")).toBe("c1 csi");
	});

	test("bidi overrides are stripped", () => {
		expect(posted(`abc${String.fromCodePoint(0x20_2e)}def`)).toBe("abcdef");
	});

	test("text that is empty once cleaned is refused", () => {
		expect(posted("   \u001B[2J  \n")).toBe("Say something.");
	});

	test("invisible format characters are stripped, so nothing blank gets posted", () => {
		expect(posted("a\u200Bb\u2060c\u00ADd\uFEFFe")).toBe("abcde");
		expect(posted("\u200B\u200B")).toBe("Say something.");
		expect(posted("\u3164 \u2800 \u{E0041}")).toBe("Say something.");
	});

	test("accents are composed, stray ones go, and a stack is cut to three", () => {
		expect(posted("cafe\u0301")).toBe("café");
		expect(posted("\u0301\u0301\u0301 zalgo \u0308x")).toBe("zalgo x");
		expect(posted(`q${"\u0301".repeat(10)}!`)).toBe(`q${"\u0301".repeat(3)}!`);
	});

	test("emoji joiners, presentation selectors and script joiners between characters are kept", () => {
		expect(posted("hi \u{1F468}\u200D\u{1F469}\u200D\u{1F467}!")).toBe(
			"hi \u{1F468}\u200D\u{1F469}\u200D\u{1F467}!"
		);
		expect(posted("love it \u2764\uFE0F")).toBe("love it \u2764\uFE0F");
		expect(posted("\u{1F3F3}\uFE0F\u200D\u{1F308} pride")).toBe(
			"\u{1F3F3}\uFE0F\u200D\u{1F308} pride"
		);
		expect(posted("\u2122\uFE0E mark")).toBe("\u2122\uFE0E mark");
		expect(posted("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645")).toBe(
			"\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"
		);
		expect(posted("\u0915\u094D\u200D\u0937")).toBe("\u0915\u094D\u200D\u0937");
	});

	test("joiners and selectors leading, trailing, repeated or alone are stripped", () => {
		expect(posted("\u200Dhello\u200C")).toBe("hello");
		expect(posted("a \u200D b \uFE0F c")).toBe("a b c");
		expect(posted("\uFE0Fstart")).toBe("start");
		expect(posted("a\u200D\u200D\u200Db")).toBe("a\u200Db");
		expect(posted("\u2764\uFE0F\uFE0F\uFE0F")).toBe("\u2764\uFE0F");
		expect(posted("\u200D\u200C\uFE0F\uFE0E")).toBe("Say something.");
		expect(posted(" \u200D \uFE0F ")).toBe("Say something.");
		expect(posted("\u0301\u200Db")).toBe("b");
		expect(posted("q\u0301\u0301\uFE0F\u0301\u0301")).toBe(
			"q\u0301\u0301\u0301"
		);
		expect(posted(`q${"\u0301\u0301\u0301\u200D".repeat(5)}b`)).toBe(
			"q\u0301\u0301\u0301\u200Db"
		);
	});

	test("500 characters is fine, 501 is refused", () => {
		expect(posted("a".repeat(500))).toBe("a".repeat(500));
		expect(posted("a".repeat(501))).toBe(
			"Keep it to 500 characters (that was 501)."
		);
	});

	test("replay halts on a chat line holding an escape", () => {
		const folded = fold(
			rules,
			[env(1, "core.chat-posted", { text: "\u001B[2Jboo" })],
			{
				strict: true,
			}
		);

		expect(folded.error?.seq).toBe(1);
		expect(folded.state.feed).toEqual([]);
	});

	test("replay halts on stored chat with a control, a bidi override, or no or far too much text", () => {
		const bad = [
			"",
			"two\nlines",
			"c1\u0085",
			`abc${String.fromCodePoint(0x20_2e)}def`,
			"\u2066x",
			"a".repeat(5000),
		];

		for (const text of bad) {
			const folded = fold(rules, [env(1, "core.chat-posted", { text })], {
				strict: true,
			});

			expect(folded.error?.seq).toBe(1);
		}
	});

	test("replay keeps stored chat today's cleaner would tidy, so a cleaner change can't halt an old log", () => {
		const stored = [
			"a\u200Bb",
			"zalgo q\u0301\u0301\u0301\u0301\u0301",
			"  spaced  out  ",
		];

		const folded = fold(
			rules,
			stored.map((text, i) => env(i + 1, "core.chat-posted", { text })),
			{ strict: true }
		);

		expect(folded.error).toBeUndefined();
		expect(folded.state.feed.map((f) => f.text)).toEqual(stored);
	});
});

describe("emotes and narration", () => {
	test("/me posts an emote", () => {
		const table = new Table();
		table.submit(ALICE, { type: "me", text: "waves  at\neveryone" });
		expect(table.last?.payload).toEqual({
			text: "waves at everyone",
			style: "emote",
		});
		expect(feed(table)).toEqual([
			{
				seq: 1,
				who: "abcdefgh",
				kind: "emote",
				text: "waves at everyone",
				gm: false,
			},
		]);
	});

	test("the GM narrates; a player is refused because narrate is GM-only", () => {
		const table = new Table();
		expect(
			table.submit(ALICE, { type: "narrate", text: "The door creaks." })
		).toBe("Only the GM can use /narrate.");
		expect(table.envelopes).toEqual([]);
		expect(
			table.submit(GM, { type: "narrate", text: "The door creaks." })
		).toBeUndefined();
		expect(table.last?.payload).toEqual({
			text: "The door creaks.",
			style: "narration",
		});
		expect(feed(table)).toEqual([
			{
				seq: 1,
				who: "GM",
				kind: "narration",
				text: "The door creaks.",
				gm: true,
			},
		]);
	});
});

const named = (raw: string) => {
	const table = new Table();

	return (
		table.submit(ALICE, { type: "name", name: raw }) ??
		table.state.core.names[ALICE]
	);
};

describe("names", () => {
	test("/name sets a display name with core.name-set, and the feed says who it was", () => {
		const table = new Table();
		expect(
			table.submit(ALICE, { type: "name", name: "Alice" })
		).toBeUndefined();
		expect(table.last?.type).toBe("core.name-set");
		expect(table.last?.payload).toEqual({ name: "Alice" });
		expect(nameOf(table.state, ALICE)).toBe("Alice");
		expect(feed(table)).toEqual([
			{
				seq: 1,
				who: "Alice",
				kind: "name",
				text: "Alice joins the table.",
				gm: false,
			},
		]);
	});

	test("names are trimmed and their inner whitespace collapsed", () => {
		expect(named("  Vex   the\tBold  ")).toBe("Vex the Bold");
	});

	test("1 to 24 characters", () => {
		expect(named("V")).toBe("V");
		expect(named("x".repeat(24))).toBe("x".repeat(24));
		expect(named("x".repeat(25))).toBe("Keep names to 24 characters.");
		expect(named("   ")).toBe("Pick a name.");
	});

	test("control characters, escapes and invisible characters are refused, not stripped", () => {
		expect(named("Al\u001B[31mice")).toBe(
			"Names can't hold control or invisible characters."
		);
		expect(named("Al\u0000ice")).toBe(
			"Names can't hold control or invisible characters."
		);

		for (const invisible of [
			"G\u200BM",
			"\u200B",
			"Vex\u2060",
			"\u3164",
			"\u2800",
			"a\u00ADb",
		]) {
			expect(named(invisible)).toBe(
				"Names can't hold control or invisible characters."
			);
		}
	});

	test("stray or stacked accents are refused in a name", () => {
		expect(named("\u0301\u0301")).toBe(
			"Names can't hold stray or stacked accents."
		);
		expect(named(`Ve${"\u0301".repeat(6)}x`)).toBe(
			"Names can't hold stray or stacked accents."
		);
	});

	test("names are stored in compatibility form, so fullwidth letters are plain ones", () => {
		expect(named("\uFF36\uFF45\uFF58")).toBe("Vex");
		expect(named("Ve\u0301ra")).toBe("V\u00E9ra");
	});

	test("a lookalike of a taken name is taken: other scripts' letters and digits for letters", () => {
		const table = new Table();
		table.submit(ALICE, { type: "name", name: "Vex the Bold" });
		table.submit(GUEST, { type: "name", name: "Cope" });
		expect(
			table.submit(BOB, {
				type: "name",
				name: "\u0421\u041E\u0420\u0415",
				seated: [GUEST],
			})
		).toBe('"\u0421\u041E\u0420\u0415" is taken; pick another name.');
		expect(table.submit(BOB, { type: "name", name: "Vex the B0ld" })).toBe(
			'"Vex the B0ld" is taken; pick another name.'
		);
		expect(table.submit(BOB, { type: "name", name: "\uFF27\uFF2D" })).toBe(
			'"GM" is taken; pick another name.'
		);
	});

	test("a capital I reads as an l, rn as m, and spaces and punctuation don't tell names apart", () => {
		const table = new Table();
		table.submit(ALICE, { type: "name", name: "Alice" });
		table.submit(GUEST, { type: "name", name: "Vern" });

		for (const lookalike of ["AIice", "Alice.", "A l i c e", "A-lice!"]) {
			expect(table.submit(BOB, { type: "name", name: lookalike })).toBe(
				`"${lookalike}" is taken; pick another name.`
			);
		}

		expect(
			table.submit(BOB, { type: "name", name: "Vem", seated: [GUEST] })
		).toBe('"Vem" is taken; pick another name.');
		expect(table.submit(BOB, { type: "name", name: "Alicia" })).toBeUndefined();
	});

	test("a name can't mix Latin letters with another script's, taken or not", () => {
		const mixed = "Names can't mix Latin letters with another script's.";
		expect(named("V\u0435x")).toBe(mixed);
		expect(named("Vex the B\u043Eld")).toBe(mixed);
		expect(named("\u0391lex")).toBe(mixed);
		expect(named("Kai \u6D77")).toBe(mixed);
	});

	test("a name in one other script is fine, digits and punctuation with it too", () => {
		expect(named("\u0412\u0435\u0440\u0430")).toBe("\u0412\u0435\u0440\u0430");
		expect(
			named("\u0391\u03BB\u03AD\u03BE\u03B1\u03BD\u03B4\u03C1\u03BF\u03C2")
		).toBe("\u0391\u03BB\u03AD\u03BE\u03B1\u03BD\u03B4\u03C1\u03BF\u03C2");
		expect(named("\u3055\u304F\u3089 2")).toBe("\u3055\u304F\u3089 2");
		expect(named("R2-D2 \u00E9t\u00E9")).toBe("R2-D2 \u00E9t\u00E9");
	});

	test("a name can't carry the table's own markers, brackets or the feed's marks", () => {
		for (const marked of [
			"Bob (GM)",
			"Bob (you)",
			"Alice (Vex)",
			"Alice [GM]",
			"↶ GM",
			"a → b",
		]) {
			expect(named(marked)).toBe(
				`"${marked}" would read like a marker; pick another name.`
			);
		}
	});

	test("a name someone else has is refused, whatever its case", () => {
		const table = new Table();
		table.submit(ALICE, { type: "name", name: "Alice" });
		table.submit(GUEST, { type: "name", name: "ilsa" });

		for (const [other, seated] of [
			["aLiCe", []],
			["ALICE", []],
			["Ilsa", [GUEST]],
		] as const) {
			expect(table.submit(BOB, { type: "name", name: other, seated })).toBe(
				`"${other}" is taken; pick another name.`
			);
		}
	});

	test("the name of a hero, creature or fighter in play is taken", () => {
		const table = new Table();
		expect(
			table.submit(BOB, {
				type: "name",
				name: "kor",
				cast: ["Kor", "Goblin 1"],
			})
		).toBe('"kor" is taken; pick another name.');
		expect(
			table.submit(BOB, {
				type: "name",
				name: "Goblin l",
				cast: ["Kor", "Goblin 1"],
			})
		).toBe('"Goblin l" is taken; pick another name.');
		expect(
			table.submit(BOB, { type: "name", name: "Korin", cast: ["Kor"] })
		).toBeUndefined();
	});

	test("a stored name the rules would refuse today still replays", () => {
		const log = [env(1, "core.name-set", { name: "Alice (Vex)" }, ALICE)];
		expect(labelOf(fold(rules, log, { strict: true }).state)(ALICE)).toBe(
			"Alice (Vex)"
		);
	});

	test("another key's default label is taken, even after they pick a name", () => {
		const table = new Table();
		table.submit(BOB, { type: "say", text: "hi" });
		expect(table.submit(ALICE, { type: "name", name: "zyxwvuts" })).toBe(
			'"zyxwvuts" is taken; pick another name.'
		);
		table.submit(BOB, { type: "name", name: "Bob" });
		expect(table.submit(ALICE, { type: "name", name: "ZYXWVUTS" })).toBe(
			'"ZYXWVUTS" is taken; pick another name.'
		);
	});

	test("the default label of someone seated is taken before they write anything", () => {
		const table = new Table();
		expect(
			table.submit(BOB, {
				type: "name",
				name: "abcdefgh",
				seated: [ALICE, BOB],
			})
		).toBe('"abcdefgh" is taken; pick another name.');
	});

	test("a guest's name is held only while that guest is seated; a key's is held for good", () => {
		const table = new Table();
		table.submit(GUEST, { type: "name", name: "Wren" });
		table.submit(ALICE, { type: "name", name: "Vex" });
		expect(
			table.submit(BOB, { type: "name", name: "wren", seated: [GUEST, BOB] })
		).toBe('"wren" is taken; pick another name.');
		expect(
			table.submit(BOB, { type: "name", name: "Vex", seated: [BOB] })
		).toBe('"Vex" is taken; pick another name.');
		expect(
			table.submit(BOB, { type: "name", name: "Wren", seated: [BOB] })
		).toBeUndefined();
	});

	test('"GM" is always taken, even if the GM has a name', () => {
		const table = new Table();
		expect(table.submit(ALICE, { type: "name", name: "gm" })).toBe(
			'"gm" is taken; pick another name.'
		);
		table.submit(GM, { type: "name", name: "Director" });
		expect(table.submit(ALICE, { type: "name", name: "GM" })).toBe(
			'"GM" is taken; pick another name.'
		);
		expect(table.submit(ALICE, { type: "name", name: "director" })).toBe(
			'"director" is taken; pick another name.'
		);
	});

	test("names that look like a guest's label are kept for guests", () => {
		expect(named("guest-beef")).toBe(
			'"guest-beef" looks like a guest\'s label; pick another name.'
		);
	});

	test("you may take your own default label, and change your name's case", () => {
		const table = new Table();
		expect(
			table.submit(ALICE, { type: "name", name: "abcdefgh" })
		).toBeUndefined();
		expect(table.submit(ALICE, { type: "name", name: "Vex" })).toBeUndefined();
		expect(table.submit(ALICE, { type: "name", name: "VEX" })).toBeUndefined();
		expect(table.submit(ALICE, { type: "name", name: "VEX" })).toBe(
			"You're already VEX."
		);
	});

	test("a name given up is free again", () => {
		const table = new Table();
		table.submit(ALICE, { type: "name", name: "Vex" });
		table.submit(ALICE, { type: "name", name: "Ash" });
		expect(table.submit(BOB, { type: "name", name: "Vex" })).toBeUndefined();
	});

	test("a player without a name needs one; the GM never does", () => {
		const table = new Table();
		expect(needsName(table.state, ALICE)).toBe(true);
		expect(needsName(table.state, GM)).toBe(false);
		table.submit(ALICE, { type: "name", name: "Vex" });
		expect(needsName(table.state, ALICE)).toBe(false);
	});
});

describe("labels", () => {
	test("default labels: GM, eight characters of the key, guest and four characters", () => {
		expect(defaultLabel(GM)).toBe("GM");
		expect(defaultLabel(ALICE)).toBe("abcdefgh");
		expect(defaultLabel(GUEST)).toBe("guest-7f3a");
	});

	test("every line shows the actor's current name, so a rename relabels earlier lines", () => {
		const table = new Table();
		table.submit(ALICE, { type: "say", text: "who am I" });
		table.submit(ALICE, { type: "name", name: "Vex" });
		table.submit(ALICE, { type: "say", text: "Vex" });
		table.submit(ALICE, { type: "name", name: "Ash" });
		expect(feed(table)).toEqual([
			{ seq: 1, who: "Ash", kind: "chat", text: "who am I", gm: false },
			{
				seq: 2,
				who: "Ash",
				kind: "name",
				text: "Vex joins the table.",
				gm: false,
			},
			{ seq: 3, who: "Ash", kind: "chat", text: "Vex", gm: false },
			{ seq: 4, who: "Ash", kind: "name", text: "Vex is now Ash", gm: false },
		]);
	});

	test("names outlive the feed cap", () => {
		const log = [env(1, "core.name-set", { name: "Vex" }, ALICE)];

		for (let seq = 2; seq <= FEED_LIMIT + 2; seq += 1) {
			log.push(env(seq, "core.chat-posted", { text: `line ${seq}` }));
		}

		const { state } = fold(openRules, log, { strict: true });
		expect(state.feed).toHaveLength(FEED_LIMIT);
		expect(state.feed[0]?.seq).toBe(3);
		expect(labelOf(state)(ALICE)).toBe("Vex");

		const decision = rules.decide(
			state,
			BOB,
			{ type: "name", name: "vex" },
			noDice,
			Date.parse(START)
		);

		expect(decision).toEqual({ refusal: '"vex" is taken; pick another name.' });
	});
});

const roll = (notation: string, dice = noDice) => {
	const table = new Table();

	return table.submit(ALICE, { type: "roll", notation }, dice) ?? table;
};

const payloadOf = (notation: string, ...faces: Array<number>) => {
	const table = roll(notation, fixedDice(...faces));

	return Predicate.isString(table) ? table : table.last?.payload;
};

const faces = (n: number) => fixedDice(...Array.from({ length: n }, () => 1));

describe("dice", () => {
	test("2d10+3 rolls two d10s from the engine's dice and stores everything in the payload", () => {
		const table = roll("2d10+3", fixedDice(4, 9));

		if (Predicate.isString(table)) {
			throw new TypeError(table);
		}

		expect(table.last?.type).toBe("core.dice-rolled");
		expect(table.last?.payload).toEqual({
			notation: "2d10+3",
			rolls: [4, 9],
			modifier: 3,
			total: 16,
		});
		expect(feed(table)).toEqual([
			{
				seq: 1,
				who: "abcdefgh",
				kind: "roll",
				text: "rolled 2d10+3: [4, 9] +3 = 16",
				gm: false,
			},
		]);
	});

	test("d20 means 1d20, and the notation is normalised", () => {
		expect(payloadOf("d20", 17)).toEqual({
			notation: "1d20",
			rolls: [17],
			modifier: 0,
			total: 17,
		});
		expect(payloadOf(" 3D6 - 1 ", 1, 2, 3)).toEqual({
			notation: "3d6-1",
			rolls: [1, 2, 3],
			modifier: -1,
			total: 5,
		});
	});

	test("1 to 100 dice of 2 to 1000 sides", () => {
		expect(roll("100d6", faces(100))).toBeInstanceOf(Table);
		expect(roll("1d2", faces(1))).toBeInstanceOf(Table);
		expect(roll("1d1000", faces(1))).toBeInstanceOf(Table);
		expect(roll("0d6")).toBe("Roll 1 to 100 dice at a time.");
		expect(roll("101d6")).toBe("Roll 1 to 100 dice at a time.");
		expect(roll("d1")).toBe("Dice have 2 to 1000 sides.");
		expect(roll("d1001")).toBe("Dice have 2 to 1000 sides.");
		expect(roll("d6+1001")).toBe("Keep the modifier within 1000.");
	});

	test("anything else is not dice", () => {
		expect(roll("fireball")).toBe(
			'"fireball" isn\'t dice; try 2d10+3, d20 or 3d6-1.'
		);
		expect(roll("2d")).toBe('"2d" isn\'t dice; try 2d10+3, d20 or 3d6-1.');
		expect(roll("2d6+")).toBe('"2d6+" isn\'t dice; try 2d10+3, d20 or 3d6-1.');
	});

	test("dice that return a face outside 1..sides are a host bug, so decide throws", () => {
		expect(() => roll("1d6", fixedDice(7))).toThrow();
		expect(() => roll("1d6", fixedDice(2.5))).toThrow();
	});

	test("replay refuses a roll whose numbers don't add up", () => {
		const bad = [
			{ notation: "2d10+3", rolls: [4, 9], modifier: 3, total: 99 },
			{ notation: "2d10+3", rolls: [4], modifier: 3, total: 7 },
			{ notation: "1d6", rolls: [7], modifier: 0, total: 7 },
			{ notation: "1d6", rolls: [3], modifier: 1, total: 4 },
		];

		for (const payload of bad) {
			const folded = fold(rules, [env(1, "core.dice-rolled", payload)], {
				strict: true,
			});

			expect(folded.error?.seq).toBe(1);
		}
	});
});

describe("replay", () => {
	test("a log reproduces the state without decide or dice", () => {
		const log = [
			env(1, "core.name-set", { name: "Vex" }, ALICE),
			env(2, "core.chat-posted", { text: "hello" }, ALICE),
			env(
				3,
				"core.dice-rolled",
				{ notation: "2d10+3", rolls: [4, 9], modifier: 3, total: 16 },
				ALICE
			),
			env(4, "core.chat-posted", {
				text: "The door creaks.",
				style: "narration",
			}),
			env(5, "core.chat-posted", { text: "waves", style: "emote" }, BOB),
		];

		const folded = fold(rules, log, { strict: true });
		expect(folded.error).toBeUndefined();
		expect(folded.state).toEqual({
			seq: 5,
			actors: [ALICE, GM, BOB],
			feed: [
				{ seq: 1, actor: ALICE, kind: "name", text: "Vex joins the table." },
				{ seq: 2, actor: ALICE, kind: "chat", text: "hello" },
				{
					seq: 3,
					actor: ALICE,
					kind: "roll",
					text: "rolled 2d10+3: [4, 9] +3 = 16",
				},
				{ seq: 4, actor: GM, kind: "narration", text: "The door creaks." },
				{ seq: 5, actor: BOB, kind: "emote", text: "waves" },
			],
			undo: [],
			redo: [],
			core: { names: { [ALICE]: "Vex" }, members: {}, door: "knock" },
			ds: rules.initial.ds,
			sw: rules.initial.sw,
			pf: rules.initial.pf,
			ff: rules.initial.ff,
			stage: rules.initial.stage,
		});
	});

	test("the same commands decided live and replayed from the log agree", () => {
		const table = new Table();
		table.submit(ALICE, { type: "name", name: "Vex" });
		table.submit(ALICE, { type: "roll", notation: "3d6" }, fixedDice(6, 5, 4));
		table.submit(GM, { type: "say", text: "nice" });
		let live = rules.initial;

		for (const envelope of table.envelopes) {
			live = rules.apply(live, envelope);
		}

		const replayed = fold(rules, throughJson(table.envelopes), {
			strict: true,
		});

		expect(replayed.state).toEqual(live);
	});

	test("a stored name today's rules would refuse still replays: rules change, logs don't", () => {
		const log = [
			env(1, "core.name-set", { name: "V\u0435x" }, ALICE),
			env(2, "core.name-set", { name: "V\u0435X" }, BOB),
			env(3, "core.name-set", { name: "Ash\u200B" }, GUEST),
		];

		const folded = fold(rules, log, { strict: true });
		expect(folded.error).toBeUndefined();
		expect(folded.state.core.names).toEqual({
			[ALICE]: "V\u0435x",
			[BOB]: "V\u0435X",
			[GUEST]: "Ash\u200B",
		});
	});

	test("replay halts on a stored name with a control, a bidi override, or no or far too much text", () => {
		for (const name of ["", "Al\u001B[31mice", "Vex\u202E", "x".repeat(500)]) {
			const folded = fold(rules, [env(1, "core.name-set", { name }, ALICE)], {
				strict: true,
			});

			expect(folded.error?.seq).toBe(1);
		}
	});

	test("a lenient reader skips another module's events; the writer halts on them", () => {
		const goblin = env(1, "draw-steel.creature-added", { name: "Goblin" });
		const log = [goblin, env(2, "core.chat-posted", { text: "hi" })];
		expect(fold(rules, log, { strict: false }).skipped).toEqual([goblin]);
		expect(fold(rules, log, { strict: true }).error).toEqual({
			seq: 1,
			message: 'unknown event type "draw-steel.creature-added"',
		});
	});
});
