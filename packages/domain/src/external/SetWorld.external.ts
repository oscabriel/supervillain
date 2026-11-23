import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { SetCharacterSchema } from "../rules/setWorld/events.ts";

export class SetWorldError extends Schema.TaggedError<SetWorldError>()(
	"SetWorldError",
	{
		seed: Schema.Int,
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export class SetWorld extends Domain.ExternalSystem(
	"SetWorld",
	{
		roll: {
			args: { seed: Schema.optionalKey(Schema.Int) },
			success: SetCharacterSchema,
			error: SetWorldError,
		},
	},
	{
		description:
			"set.world's character roll: the same seed rolls the same fighter, and no seed rolls one at random.",
	}
) {}
