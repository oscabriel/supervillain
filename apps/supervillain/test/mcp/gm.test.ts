import { describe, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ActorId } from "@supervillain/domain";
import { Context, Effect, Fiber, Schema } from "effect";

import { Knocks } from "../../src/host/Knocks.ts";
import { effect } from "../host/effect.ts";
import {
	gmSeat,
	mcpTable,
	playerSeat,
	rulesCampaign,
	textOf,
	VEX,
	WREN,
} from "./harness.ts";

const decodeSeq = Schema.decodeUnknownSync(
	Schema.Struct({ seq: Schema.Finite })
);

describe("mcp table tools", () => {
	effect(
		"wait_for_change returns the lines after a seq, or says nothing moved",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.client(playerSeat(VEX));
				const gm = yield* table.client(gmSeat);

				const now = decodeSeq(
					(yield* vex.callTool({ name: "get_table_state", arguments: {} }))
						.structuredContent
				).seq;

				const quiet = yield* vex.callTool({
					name: "wait_for_change",
					arguments: { after_seq: now, timeout_ms: 30 },
				});

				expect(quiet.structuredContent).toMatchObject({ changed: false });

				const waiting = yield* Effect.forkChild(
					vex.callTool({
						name: "wait_for_change",
						arguments: { after_seq: now, timeout_ms: 5000 },
					})
				);

				yield* Effect.sleep("20 millis");
				yield* gm.callTool({
					name: "cmd_narrate",
					arguments: { text: "The river rises." },
				});

				const moved = yield* Fiber.join(waiting);

				expect(moved.structuredContent).toMatchObject({ changed: true });
				expect(textOf(moved)).toContain("The river rises.");

				const tooLong = yield* vex.callTool({
					name: "wait_for_change",
					arguments: { after_seq: now, timeout_ms: 60_000 },
				});

				expect(tooLong.isError).toBe(true);
			})
	);

	effect(
		"batch_commands runs in order, stops at a refusal, and each step undoes alone",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const gm = yield* table.client(gmSeat);
				const before = (yield* table.state()).undo.length;

				const ran = yield* gm.callTool({
					name: "batch_commands",
					arguments: {
						commands: [
							{ type: "hero", args: { hero: "brann" } },
							{ type: "hero", args: { hero: "wren" } },
							{ type: "roll", args: { notation: "banana" } },
							{ type: "narrate", args: { text: "Never." } },
						],
					},
				});

				expect(ran.isError).toBe(true);
				expect(ran.structuredContent).toMatchObject({
					notRun: 1,
					steps: [
						{ step: 1, ok: true },
						{ step: 2, ok: true },
						{ step: 3, ok: false },
					],
				});

				const state = yield* table.state();

				expect(state.ds.heroes.map((h) => h.sheet.name)).toEqual([
					"Brann",
					"Wren",
				]);
				expect(state.feed.map((e) => e.text)).not.toContain("Never.");
				expect(state.undo.length - before).toBe(2);

				const undone = yield* table.line("gm", "/undo");

				expect(undone.kind).toBe("done");
				expect(
					(yield* table.state()).ds.heroes.map((h) => h.sheet.name)
				).toEqual(["Brann"]);

				const kept = yield* gm.callTool({
					name: "batch_commands",
					arguments: {
						commands: [
							{ type: "roll", args: { notation: "banana" } },
							{ type: "narrate", args: { text: "Still." } },
						],
						stop_on_refusal: false,
					},
				});

				expect(kept.structuredContent).toMatchObject({ notRun: 0 });
				expect((yield* table.state()).feed.at(-1)?.text).toBe("Still.");

				const forged = yield* gm.callTool({
					name: "batch_commands",
					arguments: {
						commands: [{ type: "hero", args: { hero: "kesh", sheet: {} } }],
					},
				});

				expect(forged.isError).toBe(true);
				expect(
					(yield* table.state()).ds.heroes.map((h) => h.sheet.name)
				).toEqual(["Brann"]);
			})
	);

	effect(
		"reload_content and validate_content report the campaign's problems",
		() =>
			Effect.gen(function* () {
				const dir = yield* rulesCampaign("draw-steel");
				const table = yield* mcpTable(dir);
				const gm = yield* table.client(gmSeat);

				const clean = yield* gm.callTool({
					name: "validate_content",
					arguments: {},
				});

				expect(clean.isError).not.toBe(true);

				yield* Effect.promise(async () => {
					await writeFile(
						path.join(dir, "npcs", "broken.md"),
						"---\nname: [unclosed\n---\nBody.\n"
					);
				});

				const reloaded = yield* gm.callTool({
					name: "reload_content",
					arguments: {},
				});

				expect(textOf(reloaded)).toContain("broken.md");

				const checked = yield* gm.callTool({
					name: "validate_content",
					arguments: {},
				});

				expect(textOf(checked)).toContain("broken.md");
			})
	);

	effect(
		"deny_knock turns a knocker away and create_invite makes an invite",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const gm = yield* table.client(gmSeat);
				const knocks = Context.get(table.context, Knocks);

				const nobody = yield* gm.callTool({
					name: "deny_knock",
					arguments: { who: "Rook" },
				});

				expect(nobody.isError).toBe(true);

				yield* knocks.knock({
					actor: ActorId.make(WREN),
					name: "Rook",
					fingerprint: WREN.slice(4),
					bucket: "address:test",
				});

				const seen = yield* gm.callTool({
					name: "get_table_state",
					arguments: {},
				});

				expect(seen.structuredContent).toMatchObject({
					knocks: [{ name: "Rook", actor: WREN, fingerprint: "wrenWREN" }],
				});

				const denied = yield* gm.callTool({
					name: "deny_knock",
					arguments: { who: "Rook" },
				});

				expect(denied.isError).not.toBe(true);
				expect(textOf(denied)).toContain("Turned away");
				expect(yield* knocks.pending.get).toEqual([]);

				const invite = yield* gm.callTool({
					name: "create_invite",
					arguments: { uses: 2, minutes: 30 },
				});

				expect(invite.isError).not.toBe(true);
				expect(textOf(invite)).toContain("2 uses");
			})
	);

	effect("set_auto_foes hands set.world's foes to the table", () =>
		Effect.gen(function* () {
			const table = yield* mcpTable(yield* rulesCampaign("set-world"));
			const gm = yield* table.client(gmSeat);

			const on = yield* gm.callTool({
				name: "set_auto_foes",
				arguments: { on: true },
			});

			expect(textOf(on)).toContain("The table plays the foes' turns now");
		})
	);
});
