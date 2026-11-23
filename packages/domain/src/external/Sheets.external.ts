import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { HeroSheetSchema, StatBlockSchema } from "../rules/drawSteel/schema.ts";
import {
	PfCreatureBlockSchema,
	PfHeroSheetSchema,
} from "../rules/pf2e/schema.ts";
import {
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
		map: {
			args: { query: Schema.String },
			success: { id: Schema.String, grid: MapGridSchema },
			error: [MapNotFound, MapInvalid, ContentReadError],
		},
	},
	{
		description:
			"The campaign's folder: hero sheets, stat blocks (Draw Steel's or PF2e's) and maps, found by an id or the start of one.",
	}
) {}
