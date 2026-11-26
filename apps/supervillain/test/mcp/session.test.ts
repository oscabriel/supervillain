import { describe, expect } from "bun:test";

import { KNOCK_FIRST } from "@supervillain/domain";
import { Effect, Fiber, Stream } from "effect";

import { AGENT_NEEDS_KEY } from "../../src/mcp/seat.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { gmSeat, mcpTable, playerSeat, rulesCampaign, VEX } from "./harness.ts";
import { resultOf, toolNames } from "./rpc.ts";

const settled = <A>(promise: Promise<A>) =>
	Effect.promise(async () => await promise);

describe("mcp sessions", () => {
	effect(
		"an agent without a key is turned away: its identity wouldn't last",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const guest = yield* table.session(playerSeat("guest:abc123"));

				expect(yield* settled(guest.closed)).toBe(1);
				yield* Fiber.join(guest.fiber);
				expect(guest.errors()).toContain(AGENT_NEEDS_KEY);
				expect(yield* table.presence.here.get).toEqual([]);
			})
	);

	effect("an agent the GM hasn't let in is told to knock first", () =>
		Effect.gen(function* () {
			const table = yield* mcpTable(yield* tempDir);
			const vex = yield* table.session(playerSeat(VEX));

			expect(yield* settled(vex.closed)).toBe(1);
			yield* Fiber.join(vex.fiber);
			expect(vex.errors()).toContain(KNOCK_FIRST);
		})
	);

	effect(
		"a seated agent speaks MCP over its stream, sits at the table, and /kick closes it",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const vex = yield* table.session(playerSeat(VEX));

				const hello = yield* settled(vex.rpc.initialize());

				expect(resultOf(hello)).toMatchObject({
					serverInfo: { name: "supervillain" },
				});

				const listed = toolNames(yield* settled(vex.rpc.request("tools/list")));

				expect(listed).toContain("cmd_say");
				expect(listed).not.toContain("batch_commands");
				expect(yield* table.presence.here.get).toEqual([VEX]);

				const named = yield* settled(
					vex.rpc.request("tools/call", {
						name: "cmd_name",
						arguments: { name: "Vex" },
					})
				);

				expect(resultOf(named)).not.toMatchObject({ isError: true });

				const kicked = yield* table.line("gm", "/kick Vex");

				expect(kicked.kind).toBe("done");
				expect(yield* settled(vex.closed)).toBe(0);
				yield* Fiber.join(vex.fiber);
				yield* table.presence.here.changes.pipe(
					Stream.filter((here) => here.length === 0),
					Stream.take(1),
					Stream.runDrain,
					Effect.timeout("3 seconds")
				);
			}),
		20_000
	);

	effect(
		"the GM's agent gets the GM's tools, and ends when its stream ends",
		() =>
			Effect.gen(function* () {
				const table = yield* mcpTable(yield* rulesCampaign("draw-steel"));
				const gm = yield* table.session(gmSeat);

				yield* settled(gm.rpc.initialize("2024-11-05"));

				const listed = toolNames(yield* settled(gm.rpc.request("tools/list")));

				expect(listed).toContain("batch_commands");
				expect(listed).toContain("cmd_kick");

				gm.end();
				yield* Fiber.join(gm.fiber);
				expect(yield* table.presence.here.get).toEqual([]);
			})
	);
});
