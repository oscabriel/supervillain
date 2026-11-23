import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { MapKindSchema, MapWriteFailed } from "./content.ts";

export class MapForge extends Domain.ExternalSystem(
	"MapForge",
	{
		generate: {
			args: { kind: MapKindSchema, seed: Schema.optionalKey(Schema.Int) },
			success: { id: Schema.String },
			error: MapWriteFailed,
		},
	},
	{
		description:
			"Generates a map of a kind from a seed, or one it picks, and writes it into the campaign's maps folder.",
	}
) {}
