import { describe, expect } from "bun:test";

import { Effect, Layer } from "effect";

import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableServices } from "../../src/host/services.ts";
import { campaignOf, FULL } from "../content/files.ts";
import { DOOR_OPEN_LINE } from "./campaign.ts";
import { effect } from "./effect.ts";
import type { Platform } from "./effect.ts";

const vex = "key:SHA256:vexVEXvexVEXkey";

const atFreeformTable = <A, E>(
	body: Effect.Effect<A, E, TableServices | Platform>
) =>
	Effect.gen(function* () {
		const dir = yield* campaignOf({
			...FULL,
			"events.jsonl": `${DOOR_OPEN_LINE}\n`,
		});

		return yield* Effect.scoped(
			Effect.flatMap(Layer.build(tableServices(dir)), (context) =>
				Effect.provideContext(body, context)
			)
		);
	});

const textOf = (reply: { readonly kind: string; readonly text?: string }) =>
	reply.text ?? "";

describe("the codex over a hosted freeform table", () => {
	effect(
		"the GM shows a card from its file; the player reads it, never the GM's notes",
		() =>
			atFreeformTable(
				Effect.gen(function* () {
					const shown = yield* runLine("gm", "/show mara");

					expect(shown.kind).toBe("done");

					const player = yield* runLine(vex, "/codex mara");

					expect(textOf(player)).toContain(
						"Mara Venn — Harbour-master · she/her"
					);
					expect(textOf(player)).not.toContain("GMSECRET");

					const gm = yield* runLine("gm", "/codex mara");

					expect(textOf(gm)).toContain("GM notes (only you see these):");
					expect(textOf(gm)).toContain("GMSECRET she runs the smugglers.");

					const unshown = yield* runLine(vex, "/codex ledger");

					expect(unshown).toEqual({
						kind: "refusal",
						text: "Nothing called 'ledger' is on the stage or in the codex.",
					});

					const peek = yield* runLine("gm", "/codex ledger");

					expect(textOf(peek)).toContain(
						"(Not shown to the table: /show or /reveal it.)"
					);
				})
			)
	);

	effect("/pc, /add and /sync read the campaign's Markdown", () =>
		atFreeformTable(
			Effect.gen(function* () {
				expect((yield* runLine("gm", "/pc rook")).kind).toBe("done");
				expect((yield* runLine("gm", "/add 2 thug")).kind).toBe("done");
				expect((yield* runLine("gm", "/reveal ledger")).kind).toBe("done");
				expect(yield* runLine("gm", "/sync")).toEqual({
					kind: "refusal",
					text: "Nothing changed.",
				});
				expect(yield* runLine(vex, "/show mara")).toEqual({
					kind: "refusal",
					text: "Only the GM can use /show.",
				});
				expect(yield* runLine("gm", "/show nobody")).toEqual({
					kind: "refusal",
					text: `no card "nobody" in the campaign's scenes, npcs, handouts, items, ancestries, classes, abilities, party or monsters`,
				});
			})
		)
	);
});
