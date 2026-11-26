import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ActorId } from "../Actor.context.ts";

export const KnockerSchema = Schema.Struct({
	actor: ActorId,
	name: Schema.String,
	fingerprint: Schema.String,
});

export type Knocker = typeof KnockerSchema.Type;

export class Knocks extends Domain.ExternalSystem(
	"Knocks",
	{
		pending: { success: Schema.Array(KnockerSchema) },
	},
	{
		description:
			"Who is knocking at the table's door now, with the name each asked for; knocks are never in the log.",
	}
) {}
