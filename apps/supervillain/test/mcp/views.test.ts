import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { effect } from "../host/effect.ts";
import {
	appendTo,
	gmSeat,
	mcpTable,
	playerSeat,
	readText,
	rulesCampaign,
	textOf,
	VEX,
} from "./harness.ts";
import { jsonText } from "./rpc.ts";

const SECRETS = [
	"GMSECRET",
	"twelve silver",
	"Hooked Blade",
	"Ambush at the Ford",
	"bandit-alarm",
];

const PRIVATE_KEYS = [
	"undo",
	"redo",
	"prep",
	"catalog",
	"recent",
	"gmNotes",
	"shownState",
	"knocks",
	"contentProblems",
];

const secretTable = Effect.gen(function* () {
	const dir = yield* rulesCampaign("draw-steel");

	yield* appendTo(
		dir,
		"npcs/old-mara.md",
		"\nShe hides GMSECRET-NOTE under the ferry.\n"
	);

	const table = yield* mcpTable(dir);

	for (const line of [
		"/hero brann",
		"/add bandit-chief",
		"/show npc:old-mara",
		"/tracker doom clock 4 -- GMSECRET-CLOCK",
	]) {
		const reply = yield* table.line("gm", line);
		expect(`${line}: ${reply.kind}`).toBe(`${line}: done`);
	}

	return table;
});

const leaks = (text: string): ReadonlyArray<string> =>
	SECRETS.filter((secret) => text.includes(secret));

describe("mcp views", () => {
	effect(
		"a player's state, resources and lists never carry GM notes, hidden cards, hidden trackers, monster blocks, prep or envelopes",
		() =>
			Effect.gen(function* () {
				const table = yield* secretTable;
				const vex = yield* table.client(playerSeat(VEX));

				const state = yield* vex.callTool({
					name: "get_table_state",
					arguments: { feed_limit: 500 },
				});

				const view = jsonText(state.structuredContent);

				expect(leaks(textOf(state))).toEqual([]);
				expect(leaks(view)).toEqual([]);
				expect(Object.keys(state.structuredContent ?? {}).toSorted()).toEqual([
					"band",
					"feed",
					"map",
					"myName",
					"party",
					"present",
					"ruleset",
					"seq",
					"stage",
				]);

				for (const key of PRIVATE_KEYS) {
					expect(view).not.toContain(`"${key}"`);
				}

				expect(view).toContain("Old Mara");
				expect(view).toContain("Brann");

				const resource = yield* vex.readResource({
					uri: "supervillain://table/state",
				});

				expect(leaks(readText(resource))).toEqual([]);

				const codex = yield* vex.readResource({
					uri: "supervillain://codex/npc:old-mara",
				});

				expect(readText(codex)).toContain("Old Mara");
				expect(leaks(readText(codex))).toEqual([]);

				const hidden = yield* Effect.flip(
					vex.readResource({ uri: "supervillain://codex/scene:ford-ambush" })
				);

				expect(leaks(hidden.message)).toEqual([]);

				const sheet = yield* vex.readResource({
					uri: "supervillain://sheet/brann",
				});

				expect(readText(sheet)).toContain("Brann");

				const monster = yield* Effect.flip(
					vex.readResource({ uri: "supervillain://sheet/Bandit Chief" })
				);

				expect(leaks(monster.message)).toEqual([]);
				expect(monster.message).toContain(
					'No one in the party is called "Bandit Chief".'
				);

				const typed = yield* vex.callTool({
					name: "send_line",
					arguments: { line: "/sheet Bandit Chief" },
				});

				expect(typed.isError).toBe(true);
				expect(textOf(typed)).toBe(
					'No one in the party is called "Bandit Chief".'
				);
				expect(leaks(textOf(typed))).toEqual([]);

				const typedHero = yield* vex.callTool({
					name: "send_line",
					arguments: { line: "/sheet brann" },
				});

				expect(typedHero.isError).not.toBe(true);
				expect(textOf(typedHero)).toContain("Brann");

				const files = yield* Effect.flip(
					vex.readResource({ uri: "supervillain://campaign/files" })
				);

				expect(leaks(files.message)).toEqual([]);

				const listed = jsonText([
					yield* vex.listResources(),
					yield* vex.listResourceTemplates(),
					yield* vex.listTools(),
				]);

				expect(leaks(listed)).toEqual([]);
				expect(listed).not.toContain("supervillain://campaign");
				expect(listed).not.toContain("supervillain://schema");
			}),
		20_000
	);

	effect(
		"the GM's state adds prep, notes, the real state, recent envelopes and who is knocking",
		() =>
			Effect.gen(function* () {
				const table = yield* secretTable;
				const gm = yield* table.client(gmSeat);

				const state = yield* gm.callTool({
					name: "get_table_state",
					arguments: {},
				});

				const text = jsonText(state.structuredContent);

				for (const key of [
					"prep",
					"shownState",
					"recent",
					"catalog",
					"gmNotes",
					"contentProblems",
					"knocks",
				]) {
					expect(text).toContain(`"${key}":`);
				}

				expect(text).toContain("GMSECRET-NOTE");
				expect(text).toContain("GMSECRET-CLOCK");
				expect(text).toContain("Hooked Blade");

				const files = readText(
					yield* gm.readResource({ uri: "supervillain://campaign/files" })
				);

				expect(files).toContain("supervillain://campaign/npc/old-mara");
				expect(files).toContain("supervillain://campaign/scene/ford-ambush");
				expect(files).toContain("supervillain://campaign/map/ford-road");

				const mara = readText(
					yield* gm.readResource({
						uri: "supervillain://campaign/npc/old-mara",
					})
				);

				expect(mara).toContain("twelve silver");
				expect(mara).toContain("GMSECRET-NOTE");

				const escaped = yield* Effect.flip(
					gm.readResource({
						uri: "supervillain://campaign/npc/..%2F..%2Fhost_key",
					})
				);

				expect(escaped.message).toContain("no npc called");

				const schema = readText(
					yield* gm.readResource({ uri: "supervillain://schema/npc" })
				);

				expect(schema).toContain("json-schema.org");

				const codex = readText(
					yield* gm.readResource({ uri: "supervillain://codex/npc:old-mara" })
				);

				expect(codex).toContain("GMSECRET-NOTE");

				const monster = readText(
					yield* gm.readResource({ uri: "supervillain://sheet/Bandit Chief" })
				);

				expect(monster).toContain("Hooked Blade");
			}),
		20_000
	);

	effect("help is the table's help, as a tool and a resource", () =>
		Effect.gen(function* () {
			const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
			const vex = yield* table.client(playerSeat(VEX));

			const help = yield* vex.callTool({ name: "help", arguments: {} });

			expect(textOf(help)).toContain("/roll");

			const roll = yield* vex.callTool({
				name: "help",
				arguments: { topic: "roll" },
			});

			expect(textOf(roll)).toContain("/roll");

			const unknown = yield* vex.callTool({
				name: "help",
				arguments: { topic: "frobnicate" },
			});

			expect(unknown.isError).toBe(true);

			const resource = yield* vex.readResource({ uri: "supervillain://help" });

			expect(readText(resource)).toContain("/roll");
		})
	);
});
