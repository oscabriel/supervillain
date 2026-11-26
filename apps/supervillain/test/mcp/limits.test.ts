import { describe, expect } from "bun:test";

import { Effect, Fiber } from "effect";

import {
	LINE_MOST,
	ONE_WAIT,
	PARAM_MOST,
	TOO_MANY,
} from "../../src/mcp/limits.ts";
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

const FLOOD = 40;

const TOO_LONG_PARAM = new RegExp(`longer than ${PARAM_MOST}|not found`, "u");

describe("mcp limits", () => {
	effect(
		"a player's flood of calls and reads hits the rate limit, shared across their sessions; the GM's does not",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.client(playerSeat(VEX));
				const again = yield* table.client(playerSeat(VEX));
				const gm = yield* table.client(gmSeat);

				const flood = yield* Effect.forEach(
					Array.from({ length: FLOOD }, (_, index) => index),
					() => vex.callTool({ name: "help", arguments: {} }),
					{ concurrency: 1 }
				);

				const limited = flood.filter((result) => result.isError === true);

				expect(limited.length).toBeGreaterThan(0);
				expect(new Set(limited.map(textOf))).toEqual(new Set([TOO_MANY]));

				const other = yield* again.callTool({
					name: "send_line",
					arguments: { line: "hello" },
				});

				expect(other.isError).toBe(true);
				expect(textOf(other)).toBe(TOO_MANY);

				const read = yield* Effect.flip(
					again.readResource({ uri: "supervillain://help" })
				);

				expect(read.message).toContain(TOO_MANY);

				const wren = yield* table.client(playerSeat(WREN));
				const fresh = yield* wren.callTool({ name: "help", arguments: {} });

				expect(fresh.isError).not.toBe(true);

				const gmFlood = yield* Effect.forEach(
					Array.from({ length: FLOOD }, (_, index) => index),
					() => gm.callTool({ name: "help", arguments: {} }),
					{ concurrency: 1 }
				);

				expect(gmFlood.filter((result) => result.isError === true)).toEqual([]);
			}),
		20_000
	);

	effect(
		"an oversized line or argument is refused before it is parsed, and nothing reaches the table",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.client(playerSeat(VEX));
				const { seq } = yield* table.state();

				const huge = yield* vex.callTool({
					name: "send_line",
					arguments: { line: `/say ${"x".repeat(10 * 1024)}` },
				});

				expect(huge.isError).toBe(true);
				expect(textOf(huge)).toContain("That doesn't fit send_line");
				expect(textOf(huge)).toContain(String(LINE_MOST));
				expect((yield* table.state()).seq).toBe(seq);

				const topic = yield* vex.callTool({
					name: "help",
					arguments: { topic: "r".repeat(200) },
				});

				expect(topic.isError).toBe(true);

				const who = yield* Effect.flip(
					vex.readResource({
						uri: `supervillain://sheet/${"w".repeat(PARAM_MOST + 1)}`,
					})
				);

				expect(who.message).toMatch(TOO_LONG_PARAM);

				const key = yield* Effect.flip(
					vex.readResource({
						uri: `supervillain://codex/${"k".repeat(PARAM_MOST + 1)}`,
					})
				);

				expect(key.message).toMatch(TOO_LONG_PARAM);
			}),
		20_000
	);

	effect(
		"a player parks one wait_for_change at a time; a second is refused at once",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.client(playerSeat(VEX));
				const { seq } = yield* table.state();

				const parked = yield* Effect.forkChild(
					vex.callTool({
						name: "wait_for_change",
						arguments: { after_seq: seq, timeout_ms: 10_000 },
					})
				);

				yield* Effect.sleep("100 millis");

				const second = yield* vex.callTool({
					name: "wait_for_change",
					arguments: { after_seq: seq, timeout_ms: 10_000 },
				});

				expect(second.isError).toBe(true);
				expect(textOf(second)).toBe(ONE_WAIT);

				const moved = yield* table.line("gm", "/hero brann");

				expect(moved.kind).toBe("done");

				const first = yield* Fiber.join(parked);

				expect(first.isError).not.toBe(true);
				expect(first.structuredContent).toMatchObject({ changed: true });

				const third = yield* vex.callTool({
					name: "wait_for_change",
					arguments: { after_seq: seq, timeout_ms: 0 },
				});

				expect(third.isError).not.toBe(true);
			}),
		20_000
	);

	effect(
		"batch_commands refuses another ruleset's commands at a Draw Steel table",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const gm = yield* table.client(gmSeat);
				const { seq } = yield* table.state();

				for (const type of ["pf-pc", "set-recruit", "ff-pc"]) {
					const batch = yield* gm.callTool({
						name: "batch_commands",
						arguments: { commands: [{ type, args: { name: "vex" } }] },
					});

					expect(batch.isError).toBe(true);
					expect(textOf(batch)).toContain(
						`This table's rules have no "${type}" command.`
					);
				}

				expect((yield* table.state()).seq).toBe(seq);
			}),
		20_000
	);
});
