import type { ExternalSystemKey } from "@alchemy.run/domain/ExternalSystem";
import { ifDefined } from "@supervillain/domain";
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
import type {
	CampaignConfigInvalid,
	ContentInvalid,
} from "../content/index.ts";
import { AgentLimits } from "../mcp/limits.ts";
import { AutoFoes } from "./AutoFoes.ts";
import type { AutoFoesOptions } from "./AutoFoes.ts";
import { ContentWatch } from "./ContentWatch.ts";
import { Knocks, KnocksLive } from "./Knocks.ts";
import {
	MapForgeMemory,
	MemoryMaps,
	SetWorldRefusing,
	SheetsMemory,
} from "./memoryPorts.ts";
import { Presence, SeatingLive } from "./Presence.ts";
import { SetWorldLive } from "./SetWorld.ts";
import { TableRoom } from "./TableRoom.ts";
import type { TableRoomOptions } from "./TableRoom.ts";

export type Ports =
	| ExternalSystemKey<"Sheets">
	| ExternalSystemKey<"Catalog">
	| ExternalSystemKey<"MapForge">
	| ExternalSystemKey<"SetWorld">
	| ExternalSystemKey<"Seating">
	| ExternalSystemKey<"Knocks">;

export type SetWorldPort = ExternalSystemKey<"SetWorld">;

export type TableServices =
	| TableRoom
	| Presence
	| Knocks
	| CampaignContent
	| ContentWatch
	| AutoFoes
	| AgentLimits
	| Ports;

export type Platform =
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom;

export interface TableServicesOptions extends TableRoomOptions {
	readonly setWorld?: Layer.Layer<SetWorldPort>;
	readonly autoFoes?: AutoFoesOptions;
	readonly watchContent?: boolean;
}

export type SandboxPlatform =
	| FileSystem.FileSystem
	| Path.Path
	| SecureRandom.SecureRandom;

export const sandboxServices = (
	campaignDir: string,
	options: Omit<
		TableServicesOptions,
		"sandbox" | "setWorld" | "watchContent"
	> = {}
): Layer.Layer<
	TableServices,
	LogError | CampaignConfigInvalid | ContentReadError | ContentInvalid,
	SandboxPlatform
> => {
	const content = CampaignContent.layer(campaignDir);
	const room = TableRoom.layer(campaignDir, { ...options, sandbox: true });

	const ports = Layer.mergeAll(
		SheetsMemory,
		CatalogLive,
		MapForgeMemory,
		SeatingLive,
		KnocksLive,
		SetWorldRefusing
	).pipe(Layer.provide(MemoryMaps.layer()));

	const base = Layer.mergeAll(
		content,
		Presence.layer,
		Knocks.layer,
		AgentLimits.layer(),
		AutoFoes.layer(options.autoFoes).pipe(Layer.provideMerge(room))
	);

	return ports.pipe(
		Layer.provideMerge(
			ContentWatch.layer(campaignDir, { watch: false }).pipe(
				Layer.provideMerge(base)
			)
		)
	);
};

export const tableServices = (
	campaignDir: string,
	options: TableServicesOptions = {}
): Layer.Layer<
	TableServices,
	LogError | CampaignConfigInvalid | ContentReadError | ContentInvalid,
	Platform
> => {
	if (options.sandbox === true) {
		return sandboxServices(campaignDir, options);
	}

	const content = CampaignContent.layer(campaignDir);
	const presence = Presence.layer;

	const ports = Layer.mergeAll(
		SheetsLive,
		CatalogLive,
		MapForgeLive,
		SeatingLive,
		KnocksLive,
		options.setWorld ?? SetWorldLive
	);

	const room = TableRoom.layer(campaignDir, options);

	const base = Layer.mergeAll(
		content,
		presence,
		Knocks.layer,
		AgentLimits.layer(),
		AutoFoes.layer(options.autoFoes).pipe(Layer.provideMerge(room))
	);

	const watch = ContentWatch.layer(campaignDir, {
		...ifDefined(options.watchContent, (value) => ({ watch: value })),
	}).pipe(Layer.provideMerge(base));

	return ports.pipe(Layer.provideMerge(watch));
};
