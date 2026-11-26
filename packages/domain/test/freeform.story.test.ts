import { describe, expect } from "bun:test";

import { Story } from "@alchemy.run/domain/Story";

import {
	FfCheck,
	FfJoinPc,
	FfNextTurn,
	FfPlay,
	FfStartOrder,
	FfStat,
} from "../src/commands/freeform.ts";
import { HideCard, SetStage, ShowCard, Tick } from "../src/commands/stage.ts";
import {
	FfChecked,
	FfOrderStarted,
	FfPcJoined,
	FfPlayed,
	FfRoundStarted,
	FfStatSet,
} from "../src/events/freeform.ts";
import { CardHidden, StageModeSet, StagePinned } from "../src/events/stage.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { stageModeOf, stageOf } from "../src/stage.ts";
import { effect } from "./effect.ts";
import {
	ALICE,
	as,
	GM,
	MARA_CARD,
	openDoor,
	ROOK,
	seeded,
	seedRolling,
	story,
	table,
} from "./fixtures.ts";

const { given, rejected, state, then, when } = Story;

const asGm = as(GM);

const refused = (message: string) => rejected(new Refused({ message }));

describe("a freeform table", () => {
	effect(
		"brings in a character, hands it to a player, and rolls its checks",
		() =>
			story(
				openDoor,
				seeded(seedRolling([20, 12])),
				asGm,
				when(table, new FfJoinPc({ id: "rook" })),
				refused("No sheet for 'rook' was loaded."),
				when(table, new FfJoinPc({ id: "rook", sheet: ROOK })),
				then(table, new FfPcJoined({ actor: GM, sheet: ROOK })),
				as(ALICE),
				when(table, new FfPlay({ who: "rook", seated: [ALICE] })),
				then(table, new FfPlayed({ actor: ALICE, id: "rook", player: ALICE })),
				when(
					table,
					new FfStat({ who: "rook", key: "hp", op: "add", amount: -3 })
				),
				then(
					table,
					new FfStatSet({ actor: ALICE, id: "rook", key: "hp", value: 7 })
				),
				when(table, new FfCheck({ stat: "wits" })),
				then(
					table,
					new FfChecked({
						actor: ALICE,
						id: "rook",
						stat: "wits",
						value: 2,
						notation: "1d20",
						rolls: [12],
						total: 14,
					})
				)
			)
	);

	effect("takes turns in order, and the stage follows the fight", () =>
		story(
			openDoor,
			given(table, new FfPcJoined({ actor: GM, sheet: ROOK })),
			seeded(1),
			asGm,
			when(table, new FfStartOrder({ who: [] })),
			then(table, new FfOrderStarted({ actor: GM, ids: ["rook"] })),
			state(table, (s) => {
				expect(stageModeOf(s)).toBe("encounter");
			}),
			when(table, new FfNextTurn()),
			then(table, new FfRoundStarted({ actor: GM, round: 2 }))
		)
	);
});

describe("the campaign stage", () => {
	effect("the GM shows and hides cards; players can't", () =>
		story(
			openDoor,
			seeded(1),
			as(ALICE),
			when(table, new ShowCard({ ref: "mara", card: MARA_CARD })),
			refused("Only the GM can use /show."),
			asGm,
			when(table, new ShowCard({ ref: "mara", card: MARA_CARD })),
			then(table, new StagePinned({ actor: GM, card: MARA_CARD })),
			state(table, (s) => {
				expect(stageOf(s, ALICE, "freeform").pinned.map((c) => c.key)).toEqual([
					"npc:mara",
				]);
			}),
			when(table, new HideCard({ ref: "mara" })),
			then(table, new CardHidden({ actor: GM, key: "npc:mara" })),
			when(table, new SetStage({ mode: "encounter" })),
			then(table, new StageModeSet({ actor: GM, mode: "encounter" })),
			when(table, new Tick({ id: "alarm", op: "add", amount: 1 })),
			refused("There's no tracker 'alarm'.")
		)
	);
});
