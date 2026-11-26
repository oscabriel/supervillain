import { describe, expect, test } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";

import { ActorId } from "../src/Actor.context.ts";
import { Admit, Remove, Say, SetDoor, SetName } from "../src/commands/core.ts";
import {
	ChatPosted,
	DoorSet,
	MemberAdmitted,
	MemberRemoved,
	NameSet,
} from "../src/events/core.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { checkName, isMember } from "../src/rules/core/core.ts";
import { isRefused } from "../src/rules/engine.ts";
import type { Envelope } from "../src/rules/engine.ts";
import {
	feedLines,
	initial,
	KNOCK_FIRST,
	plainText,
	rules,
	tableLabel,
} from "../src/table.ts";
import type { TableState } from "../src/table.ts";
import { effect } from "./effect.ts";
import { ALICE, as, BOB, GM, GUEST, seeded, story, table } from "./fixtures.ts";

const { given, rejected, state, then, when } = Story;

const CARA = ActorId.make(
	"key:SHA256:cara1234Cara1234cara1234Cara1234cara1234abc"
);

const asGm = as(GM);

const refused = (message: string) => rejected(new Refused({ message }));

const feedOf = (s: TableState): ReadonlyArray<string> =>
	feedLines(s, tableLabel(s, "draw-steel")).map(plainText);

const at = (
	seq: number,
	actor: string,
	type: string,
	payload: Envelope["payload"]
): Envelope => ({
	actor,
	seq,
	timestamp: "2026-01-01T00:00:00.000Z",
	type,
	payload,
});

const fold = (envelopes: ReadonlyArray<Envelope>): TableState => {
	let folded = initial;

	for (const envelope of envelopes) {
		folded = rules.apply(folded, envelope);
	}

	return folded;
};

describe("who is at the table", () => {
	test("a new table's door is set to knock, and only the GM is in", () => {
		expect(initial.core).toEqual({ names: {}, members: {}, door: "knock" });
		expect(isMember(initial, GM)).toBe(true);
		expect(isMember(initial, ALICE)).toBe(false);
		expect(isMember(initial, GUEST)).toBe(false);
	});

	test("a log from before knocking lets in everyone who wrote to it, and nobody new", () => {
		const legacy = fold([
			at(1, ALICE, "core.name-set", { name: "Alice" }),
			at(2, GM, "core.chat-posted", { text: "Welcome." }),
		]);

		expect(isMember(legacy, ALICE)).toBe(true);
		expect(isMember(legacy, BOB)).toBe(false);
		expect(
			rules.decide(legacy, ALICE, { type: "say", text: "hi" }, () => 1, 0)
		).toEqual({
			events: [{ type: "core.chat-posted", payload: { text: "hi" } }],
		});
		expect(
			rules.decide(legacy, BOB, { type: "say", text: "hi" }, () => 1, 0)
		).toEqual({
			refusal: KNOCK_FIRST,
		});
	});

	test("an open door lets anyone in but someone removed; a removal outlasts having written", () => {
		const open = fold([
			at(1, ALICE, "core.name-set", { name: "Alice" }),
			at(2, GM, "core.door-set", { door: "open" }),
			at(3, GM, "core.member-removed", { member: ALICE }),
		]);

		expect(isMember(open, BOB)).toBe(true);
		expect(isMember(open, GUEST)).toBe(true);
		expect(isMember(open, ALICE)).toBe(false);

		const back = rules.apply(
			open,
			at(4, GM, "core.member-admitted", {
				member: ALICE,
				name: "Alice",
				by: "gm",
			})
		);

		expect(isMember(back, ALICE)).toBe(true);
		expect(back.core.members).toEqual({ [ALICE]: "in" });
	});

	test("a name at the door is checked the way /name checks it", () => {
		const named = fold([at(1, ALICE, "core.name-set", { name: "Alice" })]);

		expect(checkName(named, CARA, "  Cara  ")).toBe("Cara");
		expect(checkName(named, CARA, "alice")).toEqual({
			refusal: '"alice" is taken; pick another name.',
		});
		expect(checkName(named, CARA, "GM")).toEqual({
			refusal: '"GM" is taken; pick another name.',
		});
		expect(checkName(named, CARA, "guest-1234")).toEqual({
			refusal: '"guest-1234" looks like a guest\'s label; pick another name.',
		});
		expect(checkName(named, CARA, "Vex", { cast: ["Vex"] })).toEqual({
			refusal: '"Vex" is taken; pick another name.',
		});
		expect(isRefused(checkName(named, CARA, "(Cara)"))).toBe(true);
	});

	test("replay refuses an admission it can't trust", () => {
		expect(() =>
			rules.apply(
				initial,
				at(1, GM, "core.member-admitted", { member: GM, name: "GM", by: "gm" })
			)
		).toThrow("bad admission");
		expect(() =>
			rules.apply(initial, at(1, GM, "core.member-removed", { member: GM }))
		).toThrow("the GM can't be removed");
		expect(() =>
			rules.apply(initial, at(1, GM, "core.door-set", { door: "ajar" }))
		).toThrow();
	});
});

describe("knock to join", () => {
	effect(
		"a knocker can't act until the GM lets them in by the name they asked for",
		() =>
			story(
				seeded(1),
				as(CARA),
				when(table, new Say({ text: "hello?" })),
				refused(KNOCK_FIRST),
				when(table, new SetName({ name: "Cara" })),
				refused(KNOCK_FIRST),
				asGm,
				when(table, new Admit({ who: "cara", member: CARA, name: "Cara" })),
				then(
					table,
					new MemberAdmitted({
						actor: GM,
						member: CARA,
						name: "Cara",
						by: "gm",
					})
				),
				as(CARA),
				when(table, new Say({ text: "hello!" })),
				then(table, new ChatPosted({ actor: CARA, text: "hello!" })),
				state(table, (s) => {
					expect(feedOf(s)).toEqual(["Cara joins the table.", "Cara: hello!"]);
					expect(s.core.members).toEqual({ [CARA]: "in" });
					expect(s.core.names[CARA]).toBe("Cara");
				})
			)
	);

	effect("/admit names someone knocking, once, and only for the GM", () =>
		story(
			seeded(1),
			given(table, new NameSet({ actor: ALICE, name: "Alice" })),
			asGm,
			when(table, new Admit({ who: "zed" })),
			refused('Nobody called "zed" is knocking.'),
			when(table, new Admit({ who: "alice", member: CARA, name: "alice" })),
			refused(
				'Can\'t let them in as that: "alice" is taken; pick another name.'
			),
			when(
				table,
				new Admit({ who: "cara", member: CARA, name: "Cara", by: "invite" })
			),
			then(
				table,
				new MemberAdmitted({
					actor: GM,
					member: CARA,
					name: "Cara",
					by: "invite",
				})
			),
			when(table, new Admit({ who: "cara", member: CARA, name: "Cara" })),
			refused("Cara is already at the table."),
			as(ALICE),
			when(table, new Admit({ who: "bob", member: BOB, name: "Bob" })),
			refused("Only the GM can use /admit.")
		)
	);

	effect(
		"/kick removes a member by name or key, and they must knock to come back",
		() =>
			story(
				seeded(1),
				given(table, new NameSet({ actor: ALICE, name: "Alice" })),
				given(table, new NameSet({ actor: BOB, name: "Bob" })),
				asGm,
				when(table, new Remove({ who: "alice" })),
				then(table, new MemberRemoved({ actor: GM, member: ALICE })),
				when(table, new Remove({ who: BOB })),
				then(table, new MemberRemoved({ actor: GM, member: BOB })),
				when(table, new Remove({ who: "alice" })),
				refused("Alice isn't at the table."),
				when(table, new Remove({ who: "nobody" })),
				refused('Nobody at the table is called "nobody".'),
				as(ALICE),
				when(table, new Say({ text: "still here?" })),
				refused(KNOCK_FIRST),
				state(table, (s) => {
					expect(feedOf(s).slice(-2)).toEqual([
						"Alice was removed from the table.",
						"Bob was removed from the table.",
					]);
				})
			)
	);

	effect("/door sets whether newcomers knock, and says so in the feed", () =>
		story(
			seeded(1),
			given(table, new NameSet({ actor: ALICE, name: "Alice" })),
			as(ALICE),
			when(table, new SetDoor({ door: "open" })),
			refused("Only the GM can use /door."),
			asGm,
			when(table, new SetDoor({ door: "knock" })),
			refused("The door is already set to knock."),
			when(table, new SetDoor({ door: "open" })),
			then(table, new DoorSet({ actor: GM, door: "open" })),
			when(table, new SetDoor({ door: "open" })),
			refused("The door is already open."),
			as(BOB),
			when(table, new Say({ text: "walked in" })),
			then(table, new ChatPosted({ actor: BOB, text: "walked in" })),
			asGm,
			when(table, new SetDoor({ door: "knock" })),
			then(table, new DoorSet({ actor: GM, door: "knock" })),
			as(BOB),
			when(table, new Say({ text: "still in" })),
			then(table, new ChatPosted({ actor: BOB, text: "still in" })),
			as(GUEST),
			when(table, new Say({ text: "me too?" })),
			refused(KNOCK_FIRST),
			state(table, (s) => {
				expect(feedOf(s)).toContain(
					"The door is open: anyone who connects sits down."
				);
				expect(feedOf(s)).toContain(
					"The door is set to knock: newcomers wait for the GM to let them in."
				);
			})
		)
	);
});
