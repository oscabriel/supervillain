import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { tempDir } from "../host/tempDir.ts";

export const writeTree = (
	dir: string,
	files: Readonly<Record<string, string>>
) =>
	Effect.promise(async () => {
		await Promise.all(
			Object.entries(files).map(async ([file, text]) => {
				await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
				await writeFile(path.join(dir, file), text);
			})
		);
	});

export const campaignOf = (files: Readonly<Record<string, string>>) =>
	Effect.tap(tempDir, (dir) => writeTree(dir, files));

export const FREEFORM = "rules: freeform\n";

export const ROOK = `---
name: Rook
pronouns: she/her
concept: Disgraced duelist
stats: { might: 1, wits: 2 }
resources: { hp: 10 }
tags: [brave]
items: [brass-key]
---
Owes the Gilded Hand a debt.

## GM Notes
GMSECRET she is the lost heir.
`;

export const THUG = `---
name: Dock Thug
stats: { might: 2 }
resources: { hp: 6 }
---
A brute with a hook.

## GM Notes
GMSECRET paid by the harbour-master.
`;

export const MARKET = `---
title: The Drowned Market
summary: Stalls on stilts over black water.
npcs: [mara]
handouts: [ledger]
items: [brass-key]
map: market
encounter: { map: market, monsters: [{ id: thug, count: 3 }] }
trackers:
  - { id: alarm, label: The alarm, kind: clock, max: 4 }
---
Stalls lean over the water.

## Read Aloud
Water laps at the boards.

## GM Notes
GMSECRET the ledger is forged.
### The trapdoor
GMSECRET under the fish stall.
`;

export const MARA = `---
name: Mara Venn
role: Harbour-master
pronouns: she/her
portrait: mara
tags: [ally]
---
A weathered woman with a ledger. <!-- GMSECRET in a comment -->

## GM Notes
GMSECRET she runs the smugglers.
`;

export const LEDGER = `---
title: A torn ledger page
kind: clue
---
Columns of numbers, one circled.

## GM Notes
GMSECRET the circled number is a date.
`;

export const KEY = `---
name: Brass key
summary: Opens the customs house.
---
Green with age.

## GM Notes
GMSECRET it opens the vault too.
`;

export const MAP = [
	"..........",
	"..........",
	"..........",
	"..........",
	"..........",
	"..........",
].join("\n");

export const TABLE = `---
title: The Drowned Crown
pitch: Smugglers and saints.
start: market
---
A campaign of tides.

## GM Notes
GMSECRET the crown is in the lighthouse.
`;

export const FULL = {
	"campaign.yaml": FREEFORM,
	"table.md": TABLE,
	"party/rook.md": ROOK,
	"monsters/thug.md": THUG,
	"scenes/market.md": MARKET,
	"npcs/mara.md": MARA,
	"handouts/ledger.md": LEDGER,
	"items/brass-key.md": KEY,
	"maps/market.txt": `${MAP}\n`,
	"art/mara.txt": "  /\\\n (oo)\n",
} as const;
