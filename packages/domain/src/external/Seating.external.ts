import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ActorId } from "../Actor.context.ts";

export class Seating extends Domain.ExternalSystem(
	"Seating",
	{
		here: { success: Schema.Array(ActorId) },
	},
	{
		description:
			"Who has a seat open at the table now; presence is never in the log.",
	}
) {}
