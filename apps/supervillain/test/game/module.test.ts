import { describe, expect, test } from "bun:test";

import { commands, commandsFor, feedLines, rules } from "@supervillain/domain";
import type { Module } from "@supervillain/domain/rules/core/module";

import { VEX } from "../drawSteel/harness.ts";
import { fold } from "./fold.ts";
import { openInitial } from "./open.ts";
import { ALICE, env, fixedDice, GM } from "./table.ts";

type CounterCommand =
	| { readonly type: "bump"; readonly by: number }
	| { readonly type: "reset" };

const spec = {
	usage: "/reset",
	summary: "Reset the counter.",
	gmOnly: true,
	parse: () => ({ type: "reset" }) as const,
};

describe("the table's rules", () => {
	test("a command's completer sees its own slice, the partial argument and who is typing", () => {
		const hero = commands.find((c) => c.type === "hero");

		const { state } = fold(rules, [env(1, "ds.hero-joined", { sheet: VEX })], {
			strict: true,
		});

		expect(hero?.complete?.(state, "v", GM)).toEqual(["vex"]);
		expect(hero?.complete?.(rules.initial, "v", GM)).toEqual([]);
	});

	test("a Draw Steel table's registry is core's commands then Draw Steel's, each with its GM-only flag", () => {
		expect(commandsFor("draw-steel").map((c) => [c.name, c.gmOnly])).toEqual([
			["say", false],
			["me", false],
			["narrate", true],
			["name", false],
			["roll", false],
			["admit", true],
			["kick", true],
			["door", true],
			["hero", true],
			["play", false],
			["unplay", false],
			["add", true],
			["start", true],
			["first", true],
			["turn", false],
			["done", false],
			["round", true],
			["end", true],
			["rest", true],
			["pr", false],
			["dmg", false],
			["heal", false],
			["temp", false],
			["recover", false],
			["cond", false],
			["save", false],
			["res", false],
			["surge", false],
			["malice", true],
			["token", false],
			["victory", true],
			["fs", true],
			["map", true],
			["place", false],
			["move", false],
			["dist", false],
			["push", false],
			["pull", false],
			["slide", false],
			["stage", true],
			["show", true],
			["unpin", true],
			["reveal", true],
			["hide", true],
			["tracker", true],
			["tick", true],
			["recap", true],
			["sync", true],
			["undo", false],
			["redo", false],
		]);
	});

	test("a set.world table's registry is core's commands then set.world's, sharing Draw Steel's words", () => {
		expect(
			commandsFor("set-world").map((c) => [c.name, c.type, c.gmOnly])
		).toEqual([
			["say", "say", false],
			["me", "me", false],
			["narrate", "narrate", true],
			["name", "name", false],
			["roll", "roll", false],
			["admit", "admit", true],
			["kick", "kick", true],
			["door", "door", true],
			["map", "set-map", true],
			["recruit", "set-recruit", true],
			["foe", "set-foe", true],
			["play", "set-play", false],
			["unplay", "set-unplay", false],
			["place", "set-place", false],
			["start", "set-start", true],
			["move", "set-move", false],
			["attack", "set-attack", false],
			["done", "set-done", false],
			["end", "set-end", true],
			["stage", "stage", true],
			["show", "show", true],
			["unpin", "unpin", true],
			["reveal", "reveal", true],
			["hide", "hide", true],
			["tracker", "tracker", true],
			["tick", "tick", true],
			["recap", "recap", true],
			["sync", "sync", true],
			["undo", "undo", false],
			["redo", "redo", false],
		]);
		const types = commands.map((c) => c.type);
		expect(new Set(types).size).toBe(types.length);
		expect(
			commands.filter((c) => c.name === "map").map((c) => [c.type, c.ruleset])
		).toEqual([
			["map", "draw-steel"],
			["set-map", "set-world"],
			["pf-map", "pf2e"],
			["ff-map", "freeform"],
		]);
	});

	test("each module keeps its own slice; events dispatch by type; GM-only holds across modules", () => {
		expect(Object.keys(rules.initial)).toEqual([
			"seq",
			"actors",
			"feed",
			"undo",
			"redo",
			"core",
			"ds",
			"sw",
			"pf",
			"ff",
			"stage",
		]);
		const start = openInitial;
		expect(
			rules.decide(
				start,
				ALICE,
				{ type: "narrate", text: "It rains." },
				fixedDice(),
				0
			)
		).toEqual({ refusal: "Only the GM can use /narrate." });
		expect(
			rules.decide(start, ALICE, { type: "malice", by: 2 }, fixedDice(), 0)
		).toEqual({ refusal: "Only the GM can use /malice." });

		const log = [
			env(1, "ds.malice-changed", { by: 5 }),
			env(2, "core.name-set", { name: "Vex" }, ALICE),
			env(3, "ds.hero-joined", { sheet: VEX }),
		];

		const { state } = fold(rules, log, { strict: true });
		expect(state.seq).toBe(3);
		expect(state.actors).toEqual([GM, ALICE]);
		expect(state.core).toEqual({
			names: { [ALICE]: "Vex" },
			members: {},
			door: "knock",
		});
		expect(state.ds.malice).toBe(5);
		expect(state.ds.heroes.map((h) => h.id)).toEqual(["vex"]);
		expect(state.sw).toEqual(rules.initial.sw);
		expect(state.feed.map((f) => [f.seq, f.kind])).toEqual([
			[1, "ds"],
			[2, "name"],
			[3, "ds"],
		]);
		expect(rules.knows("counter.bumped")).toBe(false);
	});

	test("an event out of seq order halts replay", () => {
		const folded = fold(
			rules,
			[
				env(1, "core.chat-posted", { text: "a" }),
				env(1, "core.chat-posted", { text: "b" }),
			],
			{ strict: true }
		);

		expect(folded.error).toEqual({
			seq: 1,
			message: "seq 1 does not follow seq 1",
		});
	});
});

describe("the registry's types", () => {
	test("a missing or extra command spec fails to compile", () => {
		interface Slice {
			readonly n: number;
		}

		type Specs<C extends { readonly type: string }> = Module<
			"m",
			Slice,
			C
		>["commands"];

		type Missing =
			{ readonly reset: typeof spec } extends Specs<CounterCommand>
				? "compiles"
				: "fails";

		type Extra = "jump" extends keyof Specs<{ readonly type: "reset" }>
			? "compiles"
			: "fails";

		const missing: Missing = "fails";
		const extra: Extra = "fails";

		expect([missing, extra]).toEqual(["fails", "fails"]);
	});
});

describe("feedLines", () => {
	test("labels come from the labeller handed in, at projection time", () => {
		const { state } = fold(
			rules,
			[env(1, "core.chat-posted", { text: "hi" }, ALICE)],
			{
				strict: true,
			}
		);

		expect(feedLines(state, (actor) => `<${actor.slice(0, 3)}>`)).toEqual([
			{ seq: 1, who: "<key>", kind: "chat", text: "hi", gm: false },
		]);
	});
});
