import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { StageCardSchema } from "../rules/core/stage.ts";
import { HeroSheetSchema, StatBlockSchema } from "../rules/drawSteel/schema.ts";
import { FfSheetSchema } from "../rules/freeform/schema.ts";
import {
	PfCreatureBlockSchema,
	PfHeroSheetSchema,
} from "../rules/pf2e/schema.ts";
import {
	CardAmbiguous,
	CardNotFound,
	ContentReadError,
	MapGridSchema,
	MapInvalid,
	MapNotFound,
	SheetAmbiguous,
	SheetInvalid,
	SheetNotFound,
} from "./content.ts";

export class Sheets extends Domain.ExternalSystem(
	"Sheets",
	{
		hero: {
			args: { query: Schema.String },
			success: HeroSheetSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		monster: {
			args: { query: Schema.String },
			success: StatBlockSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		pfHero: {
			args: { query: Schema.String },
			success: PfHeroSheetSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		pfMonster: {
			args: { query: Schema.String },
			success: PfCreatureBlockSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		ffHero: {
			args: { query: Schema.String },
			success: FfSheetSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		ffMonster: {
			args: { query: Schema.String },
			success: FfSheetSchema,
			error: [SheetInvalid, SheetNotFound, SheetAmbiguous, ContentReadError],
		},
		map: {
			args: { query: Schema.String },
			success: { id: Schema.String, grid: MapGridSchema },
			error: [MapNotFound, MapInvalid, ContentReadError],
		},
		card: {
			args: { query: Schema.String },
			success: StageCardSchema,
			error: [CardNotFound, CardAmbiguous, ContentReadError],
		},
		cards: {
			args: { keys: Schema.Array(Schema.String) },
			success: Schema.Array(StageCardSchema),
			error: [ContentReadError],
		},
	},
	{
		description:
			"The campaign's folder: hero sheets, stat blocks (Draw Steel's, PF2e's or freeform), maps and player-safe cards, found by an id or the start of one.",
	}
) {}
