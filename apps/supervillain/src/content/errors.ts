import { Schema } from "effect";

export class CampaignConfigInvalid extends Schema.TaggedError<CampaignConfigInvalid>()(
	"CampaignConfigInvalid",
	{
		file: Schema.String,
		message: Schema.String,
	}
) {}
