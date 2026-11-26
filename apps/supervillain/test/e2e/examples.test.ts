import { describe, expect } from "bun:test";
import { cp, readdir } from "node:fs/promises";
import nodePath from "node:path";

import { fightLinesOf, prepStage, stageOf } from "@supervillain/domain";
import { Effect, Layer, Schema } from "effect";

import {
	CampaignContent,
	docsOf,
	validateCampaign,
} from "../../src/content/index.ts";
import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { openDoor, SAMPLE } from "../host/campaign.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { cli } from "./cli.ts";

const ALICE = "key:SHA256:aliceAAAAkeyfingerprint";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const GM_ONLY = [
	"The chief stays behind the cart",
	"Mara has been paid",
	"She owes the bandit chief",
	"Gall is the chief",
	"The lantern totals",
	"music box",
	"someone in town has been buying",
];

const copied = Effect.tap(tempDir, (dir) =>
	Effect.promise(async () => {
		await cp(SAMPLE, dir, { recursive: true });
	})
);

const markdownIn = async (dir: string): Promise<ReadonlyArray<string>> => {
	const found = await readdir(dir, { recursive: true });

	return found
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.map((f) => f.split(nodePath.sep).join("/"))
		.toSorted();
};

describe("examples/campaign in Markdown", () => {
	effect(
		"every Markdown file loads, cross-checks and builds with no problems",
		() =>
			Effect.gen(function* () {
				const validation = yield* validateCampaign(SAMPLE);

				const files = yield* Effect.promise(
					async () => await markdownIn(SAMPLE)
				);

				expect(validation.rules).toBe("draw-steel");
				expect(validation.problems).toEqual([]);
				expect(files).toEqual([
					"abilities/judgment.md",
					"handouts/ford-sketch.md",
					"handouts/wanted-poster.md",
					"items/chiefs-ledger.md",
					"npcs/old-mara.md",
					"scenes/aftermath.md",
					"scenes/ford-ambush.md",
					"table.md",
				]);
				const loaded = docsOf(validation.index).map((d) => d.file);
				const table = validation.index.table?.file ?? "no table.md";

				expect([...loaded, table].toSorted()).toEqual([...files]);
				expect(validation.index.table?.front.start).toBe("ford-ambush");
				expect(validation.index.table?.front.rules).toBeUndefined();
			})
	);

	effect(
		"supervillain check and supervillain schema pass on it",
		() =>
			Effect.gen(function* () {
				const dir = yield* copied;
				const checked = yield* cli(["check", dir]);

				expect(checked.exitCode).toBe(0);
				expect(checked.stderr).toBe("");
				expect(checked.stdout).toContain(
					`${dir}: 8 campaign files, no problems`
				);

				const schema = yield* cli(["schema", dir]);

				expect(schema.exitCode).toBe(0);
				expect(
					yield* Effect.promise(
						async () => await readdir(nodePath.join(dir, "schemas"))
					)
				).toContain("scene.schema.json");

				const again = yield* cli(["check", dir]);

				expect(again.exitCode).toBe(0);
			}),
		30_000
	);

	effect(
		"the ford ambush plays from the prep panel, and its GM notes never reach a player",
		() =>
			Effect.gen(function* () {
				const dir = yield* copied;
				yield* openDoor(dir);

				yield* Effect.scoped(
					Effect.flatMap(Layer.build(tableServices(dir)), (context) =>
						Effect.provideContext(
							Effect.gen(function* () {
								const content = yield* CampaignContent;
								const room = yield* TableRoom;

								for (const line of [
									"/show ford-ambush",
									"/show old-mara",
									"/show ford-sketch",
									"/reveal wanted-poster",
									"/reveal chiefs-ledger",
									"/tracker bandit-alarm clock 4 The bandits' alarm",
									"/tracker bandit-alarm show",
								]) {
									expect([line, (yield* runLine("gm", line)).kind]).toEqual([
										line,
										"done",
									]);
								}

								const state = yield* room.state;
								const view = stageOf(state, ALICE, "draw-steel");
								const shown = json(view);

								expect(view.scene?.title).toBe("Ambush at the Ford");
								expect(json(view.scene?.readAloud)).toContain(
									"Toll's gone up."
								);
								expect(
									view.pinned.find((c) => c.key === "handout:ford-sketch")?.map
										?.name
								).toBe("The Ford Road");
								expect(view.codex.map((e) => e.key).toSorted()).toEqual([
									"handout:ford-sketch",
									"handout:wanted-poster",
									"item:chiefs-ledger",
									"npc:old-mara",
									"scene:ford-ambush",
								]);
								expect(shown).toContain("W A N T E D");

								for (const secret of GM_ONLY) {
									expect([secret, shown.includes(secret)]).toEqual([
										secret,
										false,
									]);
								}

								const player = yield* runLine(ALICE, "/codex ford-ambush");
								const gm = yield* runLine("gm", "/codex ford-ambush");

								expect(json(player)).not.toContain(
									"The chief stays behind the cart"
								);
								expect(json(gm)).toContain("The chief stays behind the cart");

								const catalog = yield* content.catalog;

								const fight = prepStage(state.stage, catalog, (e) =>
									fightLinesOf(e, "draw-steel")
								)
									.flatMap((s) => s.items)
									.find((item) => item.lines !== undefined);

								expect(fight?.lines).toEqual([
									"/map ford-road",
									"/add bandit-chief",
									"/add bandit-bruiser x2",
									"/add bandit-cutpurse x4",
									"/add bandit-slinger x4",
								]);
							}),
							context
						)
					)
				);
			}),
		15_000
	);
});
