import * as Domain from "@alchemy.run/domain";

import { ContentReadError, PrepCatalogSchema } from "./content.ts";

export class Catalog extends Domain.ExternalSystem(
	"Catalog",
	{
		list: { success: PrepCatalogSchema, error: ContentReadError },
	},
	{
		description:
			"Every hero, monster and map in the campaign's folder, with its name, for the GM's prep panel.",
	}
) {}
