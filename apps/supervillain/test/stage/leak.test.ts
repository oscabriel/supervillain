import { describe, expect } from "bun:test";

import {
	cardLines,
	codexText,
	completeLine,
	feedLines,
	partyOf,
	sheetOf,
	stageOf,
	tableLabel,
} from "@supervillain/domain";
import { Effect, Schema } from "effect";

import { keyedDocs } from "../../src/content/index.ts";
import { withContent } from "../content/content.ts";
import { campaignOf, FULL } from "../content/files.ts";
import { ALICE, fixedDice, GM, Table } from "../game/table.ts";
import { effect } from "../host/effect.ts";

const SENTINEL = "GMSECRET";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PLAYER_LINES = [
	"/",
	"/codex ",
	"/codex n",
	"/show ",
	"/reveal ",
	"/hide ",
	"/sync ",
	"/sheet ",
	"/stat rook ",
	"/tick ",
];

describe("GM notes never reach a player", () => {
	effect(
		"every player projection of a full campaign is free of the GM's sentinel",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf(FULL);

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const index = yield* content.index;
						const keys = keyedDocs(index).map((k) => k.key);
						const cards = yield* content.cards(keys);
						const rook = yield* content.ffHero("rook");
						const thug = yield* content.ffMonster("thug");

						expect(keys.toSorted()).toEqual([
							"handout:ledger",
							"item:brass-key",
							"monster:thug",
							"npc:mara",
							"party:rook",
							"scene:market",
						]);

						for (const key of keys) {
							expect(yield* content.gmNotes(key)).toContain(SENTINEL);
						}

						const table = new Table();
						table.run(GM, { type: "ff-pc", id: "rook", sheet: rook });
						table.run(GM, {
							type: "ff-add",
							monster: "thug",
							count: 2,
							sheet: thug,
						});
						table.run(ALICE, { type: "name", name: "Alice" });
						table.run(ALICE, { type: "ff-play", who: "rook", seated: [ALICE] });
						table.run(ALICE, { type: "ff-check", stat: "wits" }, fixedDice(11));

						for (const card of cards) {
							if (
								card.kind === "scene" ||
								card.kind === "npc" ||
								card.kind === "item"
							) {
								table.run(GM, { type: "show", ref: card.key, card });
							} else {
								table.run(GM, { type: "reveal", ref: card.key, card });
							}
						}

						table.run(GM, {
							type: "tracker",
							id: "plot",
							action: "set",
							kind: "counter",
							label: "GMSECRET plot",
						});
						table.run(GM, { type: "tick", id: "plot", op: "add", amount: 2 });
						table.run(GM, {
							type: "sync",
							cards: cards.map((card) => ({
								...card,
								title: `${card.title} again`,
							})),
						});

						const { state } = table;

						const seen = [
							stageOf(state, ALICE, "freeform"),
							partyOf(state, ALICE, "freeform"),
							feedLines(state, tableLabel(state, "freeform")),
							...PLAYER_LINES.map((line) =>
								completeLine(state, ALICE, line, "freeform")
							),
							sheetOf(state, "rook", "freeform"),
							sheetOf(state, "thug-1", "freeform"),
							codexText(state, undefined),
							...keys.map((key) => codexText(state, key)),
							...cards.map(cardLines),
						];

						expect(json(seen)).not.toContain(SENTINEL);
						expect(
							stageOf(state, ALICE, "freeform").pinned.length
						).toBeGreaterThan(0);
						expect(
							stageOf(state, GM, "freeform").trackers.map((t) => t.label)
						).toEqual(["GMSECRET plot"]);
					})
				);
			})
	);

	effect(
		"nothing a player sees comes from a GM heading, at any depth or in a comment",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"npcs/spy.md": `---
name: The Spy
---
Seen at the docks. <!-- GMSECRET aside -->

GM Notes
--------
GMSECRET underlined

# GM

GMSECRET top level

## Game Master notes
GMSECRET second

### deeper
GMSECRET third

\`\`\`
## GM Notes
fenced, so shown
\`\`\`
`,
				});

				yield* withContent(dir, (content) =>
					Effect.gen(function* () {
						const spy = yield* content.card("npc:spy");

						expect(json(spy)).not.toContain(SENTINEL);
						expect(cardLines(spy)).toContain("Seen at the docks.");
					})
				);
			})
	);
});
