import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { effect } from "../host/effect.ts";
import {
	gmSeat,
	mcpTable,
	playerSeat,
	RULES,
	rulesCampaign,
	textOf,
	VEX,
} from "./harness.ts";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const META = ["get_table_state", "help", "send_line", "wait_for_change"];

const GM_ONLY_TOOLS = [
	"batch_commands",
	"create_invite",
	"deny_knock",
	"reload_content",
	"validate_content",
];

describe("mcp tools", () => {
	for (const rules of RULES) {
		effect(
			`${rules}: a player gets the table's commands they may use, the GM every one`,
			() =>
				Effect.gen(function* () {
					const table = yield* mcpTable(yield* rulesCampaign(rules));
					const gm = yield* table.client(gmSeat);
					const vex = yield* table.client(playerSeat(VEX));

					const gmTools = (yield* gm.listTools()).tools;
					const vexTools = (yield* vex.listTools()).tools;
					const gmNames = gmTools.map((t) => t.name);
					const vexNames = vexTools.map((t) => t.name);

					for (const name of [...gmNames, ...vexNames]) {
						expect(name).toMatch(TOOL_NAME);
					}

					for (const name of META) {
						expect(gmNames).toContain(name);
						expect(vexNames).toContain(name);
					}

					for (const name of GM_ONLY_TOOLS) {
						expect(gmNames).toContain(name);
						expect(vexNames).not.toContain(name);
					}

					expect(gmNames.includes("set_auto_foes")).toBe(rules === "set-world");
					expect(vexNames).not.toContain("set_auto_foes");

					expect(gmNames).toContain("cmd_say");
					expect(vexNames).toContain("cmd_say");
					expect(gmNames).toContain("cmd_kick");
					expect(vexNames).not.toContain("cmd_kick");
					expect(gmNames).toContain("cmd_show");
					expect(vexNames).not.toContain("cmd_show");

					const own = {
						"draw-steel": "cmd_pr",
						"set-world": "cmd_set-attack",
						pf2e: "cmd_pf-strike",
						freeform: "cmd_ff-check",
					}[rules];

					expect(vexNames).toContain(own);

					for (const other of [
						"cmd_pr",
						"cmd_set-attack",
						"cmd_pf-strike",
						"cmd_ff-check",
					]) {
						if (other !== own) {
							expect(gmNames).not.toContain(other);
						}
					}

					for (const tool of gmTools) {
						const properties = Object.keys(tool.inputSchema.properties ?? {});

						expect(properties).not.toContain("_tag");

						for (const fact of [
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
						]) {
							expect(`${tool.name}.${fact} ${properties.includes(fact)}`).toBe(
								`${tool.name}.${fact} false`
							);
						}

						expect(tool.inputSchema.additionalProperties).toBe(false);
					}
				}),
			20_000
		);
	}

	effect("a command lands in the log and comes back as the feed's lines", () =>
		Effect.gen(function* () {
			const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
			const vex = yield* table.client(playerSeat(VEX));

			const said = yield* vex.callTool({
				name: "cmd_say",
				arguments: { text: "Hello, table." },
			});

			expect(said.isError).not.toBe(true);
			expect(textOf(said)).toContain("Hello, table.");
			expect(said.structuredContent).toMatchObject({
				lines: [expect.stringContaining("Hello, table.")],
			});

			const state = yield* table.state();

			expect(state.feed.at(-1)?.text).toBe("Hello, table.");
		})
	);

	effect(
		"a refusal is a tool result with isError, never a protocol error",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.client(playerSeat(VEX));

				const refused = yield* vex.callTool({
					name: "cmd_roll",
					arguments: { notation: "banana" },
				});

				expect(refused.isError).toBe(true);
				expect(textOf(refused).length).toBeGreaterThan(0);

				const misfit = yield* vex.callTool({
					name: "cmd_say",
					arguments: { words: "hi" },
				});

				expect(misfit.isError).toBe(true);
				expect(textOf(misfit)).toContain('"words"');

				const line = yield* vex.callTool({
					name: "send_line",
					arguments: { line: "/kick gm" },
				});

				expect(line.isError).toBe(true);
				expect(textOf(line)).toContain("Only the GM");
			})
	);

	effect("forged host facts are refused and never reach the table", () =>
		Effect.gen(function* () {
			const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
			const gm = yield* table.client(gmSeat);

			const forgedSheet = yield* gm.callTool({
				name: "cmd_add",
				arguments: {
					monster: "bandit-chief",
					count: 1,
					sheet: { name: "Forged", stamina: 9999 },
				},
			});

			expect(forgedSheet.isError).toBe(true);
			expect(textOf(forgedSheet)).toContain('"sheet"');

			const forgedGrid = yield* gm.callTool({
				name: "cmd_map",
				arguments: { id: "ford-road", grid: { width: 1, height: 1 } },
			});

			expect(forgedGrid.isError).toBe(true);
			expect(textOf(forgedGrid)).toContain('"grid"');

			const forgedCard = yield* gm.callTool({
				name: "cmd_show",
				arguments: {
					ref: "npc:old-mara",
					card: { key: "npc:old-mara", title: "Forged", body: [] },
				},
			});

			expect(forgedCard.isError).toBe(true);

			const forgedMember = yield* gm.callTool({
				name: "cmd_admit",
				arguments: { who: "anyone", member: VEX, name: "Vex" },
			});

			expect(forgedMember.isError).toBe(true);

			const state = yield* table.state();

			expect(state.ds.creatures).toEqual([]);
			expect(state.ds.map).toBeUndefined();
			expect(state.stage.cards).toEqual({});
			expect(state.core.members[VEX]).toBeUndefined();

			const added = yield* gm.callTool({
				name: "cmd_add",
				arguments: { monster: "bandit-chief", count: 1 },
			});

			expect(added.isError).not.toBe(true);
			expect((yield* table.state()).ds.creatures.map((c) => c.name)).toEqual([
				"Bandit Chief",
			]);
		})
	);
});
