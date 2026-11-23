import type { ExternalSystemKey } from "@alchemy.run/domain/ExternalSystem";
import type { ContentReadError } from "@supervillain/domain";
import type { LogError } from "@supervillain/platform-jsonl";
import { Layer } from "effect";
import type { FileSystem, Path } from "effect";
import type { SecureRandom } from "effect/crypto";
import type { HttpClient } from "effect/http";

import {
	CampaignContent,
	CatalogLive,
	MapForgeLive,
	SheetsLive,
} from "../content/index.ts";
import type { CampaignConfigInvalid } from "../content/index.ts";
import { AutoFoes } from "./AutoFoes.ts";
import type { AutoFoesOptions } from "./AutoFoes.ts";
import { Presence, SeatingLive } from "./Presence.ts";
import { SetWorldLive } from "./SetWorld.ts";
import { TableRoom } from "./TableRoom.ts";
import type { TableRoomOptions } from "./TableRoom.ts";

export type Ports =
	| ExternalSystemKey<"Sheets">
	| ExternalSystemKey<"Catalog">
	| ExternalSystemKey<"MapForge">
	| ExternalSystemKey<"SetWorld">
	| ExternalSystemKey<"Seating">;

export type SetWorldPort = ExternalSystemKey<"SetWorld">;

export type TableServices =
	| TableRoom
	| Presence
	| CampaignContent
	| AutoFoes
	| Ports;

export type Platform =
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom;

export interface TableServicesOptions extends TableRoomOptions {
	readonly setWorld?: Layer.Layer<SetWorldPort>;
	readonly autoFoes?: AutoFoesOptions;
}

export const tableServices = (
	campaignDir: string,
	options: TableServicesOptions = {}
): Layer.Layer<
	TableServices,
	LogError | CampaignConfigInvalid | ContentReadError,
	Platform
> => {
	const content = CampaignContent.layer(campaignDir);
	const presence = Presence.layer;

	const ports = Layer.mergeAll(
		SheetsLive,
		CatalogLive,
		MapForgeLive,
		SeatingLive,
		options.setWorld ?? SetWorldLive
	);

	const room = TableRoom.layer(campaignDir, options);

	return ports.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				content,
				presence,
				AutoFoes.layer(options.autoFoes).pipe(Layer.provideMerge(room))
			)
		)
	);
};
