import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
	COMMAND_CLASSES,
	commandClassOf,
	commandFromInput,
	commandInputFields,
	HOST_FACT_KEYS,
	hostFactKeysOf,
} from "../src/commandInput.ts";
import { commands } from "../src/table.ts";

const FACT_NAMES = new Set([
	"sheet",
	"grid",
	"seated",
	"cast",
	"whose",
	"character",
	"playerActor",
	"card",
	"cards",
	"member",
]);

const inputOf = async (type: string) =>
	await Effect.runPromise(
		commandFromInput(type, {}).pipe(
			Effect.flip,
			Effect.map((e) => e.message)
		)
	);

describe("command input", () => {
	test("every command the table knows has a class, and every class a command", () => {
		const types = new Set(commands.map((c) => c.type));

		expect(COMMAND_CLASSES.map((c): string => c.tag).toSorted()).toEqual(
			[...types].toSorted()
		);

		for (const type of types) {
			expect(String(commandClassOf(type)?.tag)).toBe(type);
		}
	});

	test("every host-filled field of every command is listed as a host fact", () => {
		for (const c of COMMAND_CLASSES) {
			const listed = new Set(hostFactKeysOf(c.tag));

			for (const key of Object.keys(c.fields)) {
				if (FACT_NAMES.has(key)) {
					expect(`${c.tag}.${key} ${listed.has(key)}`).toBe(
						`${c.tag}.${key} true`
					);
				}
			}

			for (const key of listed) {
				expect(Object.keys(c.fields)).toContain(key);
			}
		}

		expect(Object.keys(HOST_FACT_KEYS).toSorted()).toEqual(
			COMMAND_CLASSES.map((c): string => c.tag)
				.filter((tag) => hostFactKeysOf(tag).length > 0)
				.toSorted()
		);
	});

	test("what a player types stays an input: /name's name, set.world's seed, a map's generation", () => {
		expect(Object.keys(commandInputFields("name") ?? {})).toEqual(["name"]);
		expect(Object.keys(commandInputFields("admit") ?? {})).toEqual(["who"]);
		expect(Object.keys(commandInputFields("set-recruit") ?? {})).toEqual([
			"name",
			"seed",
		]);
		expect(Object.keys(commandInputFields("map") ?? {})).toEqual([
			"id",
			"generate",
		]);
		expect(Object.keys(commandInputFields("play") ?? {})).toEqual([
			"hero",
			"player",
		]);
		expect(commandInputFields("nonsense")).toBeUndefined();
	});

	test("an input becomes the command it names, and a forged host fact is refused", async () => {
		expect(
			await Effect.runPromise(commandFromInput("hero", { hero: "vex" }))
		).toEqual({ type: "hero", hero: "vex" });

		expect(
			await Effect.runPromise(
				commandFromInput("say", { text: "hello" }).pipe(
					Effect.map((c) => c.type)
				)
			)
		).toBe("say");

		const forged = await Effect.runPromise(
			commandFromInput("hero", {
				hero: "vex",
				sheet: { name: "Vex", stamina: 9999 },
			}).pipe(Effect.flip)
		);

		expect(forged.message).toContain("That doesn't fit /hero");
		expect(forged.message).toContain('"sheet"');

		const admitted = await Effect.runPromise(
			commandFromInput("admit", { who: "Vex", member: "key:SHA256:x" }).pipe(
				Effect.flip
			)
		);

		expect(admitted.message).toContain("member");
		expect(await inputOf("say")).toContain("text");
		expect(await inputOf("nonsense")).toBe('There is no "nonsense" command.');
	});

	test("a table's ruleset refuses another ruleset's commands", async () => {
		const types = ["pf-pc", "set-recruit", "ff-pc"];

		const refused = await Promise.all(
			types.map(
				async (type) =>
					await Effect.runPromise(
						commandFromInput(type, { name: "vex" }, "draw-steel").pipe(
							Effect.flip,
							Effect.map((foreign) => foreign.message)
						)
					)
			)
		);

		expect(refused).toEqual(
			types.map((type) => `This table's rules have no "${type}" command.`)
		);

		expect(
			await Effect.runPromise(
				commandFromInput("hero", { hero: "vex" }, "draw-steel")
			)
		).toEqual({ type: "hero", hero: "vex" });

		expect(
			await Effect.runPromise(
				commandFromInput("say", { text: "hi" }, "pf2e").pipe(
					Effect.map((c) => c.type)
				)
			)
		).toBe("say");
	});
});
