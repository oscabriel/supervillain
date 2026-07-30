import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
	CORE_MAP_LOADED,
	isRecord,
	MAP_DIRECTORY,
	MAP_FILE_EXTENSION,
	mapDimensions,
	parseMapFile,
	readMapLoadedPayload,
	SNAPSHOT_SCHEMA_VERSION,
	validateSnapshotDocument,
} from "@supervillain/core";
import type {
	BattleMap,
	Envelope,
	SnapshotArtifactType,
	SnapshotDocumentV1,
	SnapshotMapGridV1,
	ViewEntry,
} from "@supervillain/core";
import {
	content as drawSteelContent,
	snapshotCharacter as drawSteelSnapshotCharacter,
} from "@supervillain/draw-steel/content";
import {
	apply as drawSteelApply,
	init as drawSteelInit,
} from "@supervillain/draw-steel/model";
import { view as drawSteelView } from "@supervillain/draw-steel/view";
import {
	content as fakeContent,
	snapshotCharacter as fakeSnapshotCharacter,
} from "@supervillain/fake/content";
import { apply as fakeApply, init as fakeInit } from "@supervillain/fake/model";
import { view as fakeView } from "@supervillain/fake/view";
import { createTableFold } from "@supervillain/table";

interface CharacterSnapshotContribution {
	readonly card: SnapshotDocumentV1["card"];
	readonly sections: Extract<
		SnapshotDocumentV1,
		{ readonly artifactType: "character" }
	>["sections"];
}

interface PublishGame {
	readonly snapshotCharacter: (
		bytes: Uint8Array,
		name: string
	) => CharacterSnapshotContribution;
	readonly validate: (bytes: Uint8Array) =>
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly errors: readonly { readonly message: string }[];
		  };
	readonly viewEntry: ViewEntry<unknown, unknown, unknown>;
}

const games = new Map<string, PublishGame>([
	[
		"draw-steel",
		{
			snapshotCharacter: drawSteelSnapshotCharacter,
			validate: drawSteelContent.validate,
			viewEntry: {
				model: { apply: drawSteelApply, init: drawSteelInit },
				view: drawSteelView,
			} as ViewEntry<unknown, unknown, unknown>,
		},
	],
	[
		"fake",
		{
			snapshotCharacter: fakeSnapshotCharacter,
			validate: fakeContent.validate,
			viewEntry: {
				model: { apply: fakeApply, init: fakeInit },
				view: fakeView,
			} as ViewEntry<unknown, unknown, unknown>,
		},
	],
]);

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

const resolveCampaignFile = async (
	direct: string,
	insideCampaign: string
): Promise<string> => {
	try {
		await access(direct);
		return direct;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	return insideCampaign;
};

const readNamedCharacter = async (
	campaignFolder: string,
	name: string
): Promise<Uint8Array> => {
	const fileName = name.endsWith(".json") ? name : `${name}.json`;
	const candidate = await resolveCampaignFile(
		name,
		path.join(campaignFolder, "characters", fileName)
	);
	try {
		return await readFile(candidate);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const directory = path.join(campaignFolder, "characters");
	let directoryEntries: string[];
	try {
		directoryEntries = await readdir(directory);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new Error(
				`Character '${name}' was not found in the campaign folder.`,
				{ cause: error }
			);
		}
		throw error;
	}
	const fileNames = directoryEntries
		.filter((entry) => entry.endsWith(".json"))
		.toSorted();
	const candidates = await Promise.all(
		fileNames.map(async (entry) => {
			const bytes = await readFile(path.join(directory, entry));
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder().decode(bytes));
			} catch {
				value = undefined;
			}
			return isRecord(value) && value.name === name ? bytes : undefined;
		})
	);
	const found = candidates.find((bytes) => bytes !== undefined);
	if (found === undefined) {
		throw new Error(
			`Character '${name}' was not found in the campaign folder.`
		);
	}
	return found;
};

const mapGrid = (map: BattleMap): SnapshotMapGridV1 => ({
	legend: map.legend,
	name: map.name,
	rows: map.rows,
	type: "map-grid",
});

const validateProducedDocument = (
	document: SnapshotDocumentV1
): SnapshotDocumentV1 => {
	const validated = validateSnapshotDocument(document);
	if (!validated.ok) {
		throw new Error(validated.errors.map(({ message }) => message).join(" "));
	}
	return validated.document;
};

const readLog = async (
	campaignFolder: string
): Promise<readonly Envelope[]> => {
	const text = await readFile(
		path.join(campaignFolder, "events.jsonl"),
		"utf-8"
	);
	const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
	return lines.map((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`events.jsonl line ${index + 1} is not JSON.`);
		}
		if (
			!isRecord(value) ||
			typeof value.actor !== "string" ||
			typeof value.seq !== "number" ||
			typeof value.timestamp !== "string" ||
			typeof value.type !== "string" ||
			!("payload" in value)
		) {
			throw new Error(`events.jsonl line ${index + 1} is not an Envelope.`);
		}
		return value as unknown as Envelope;
	});
};

const campaignGameId = async (campaignFolder: string): Promise<string> => {
	const text = await readFile(
		path.join(campaignFolder, "events.jsonl"),
		"utf-8"
	);
	const [firstLine] = text.split(/\r?\n/u, 1);
	let first: unknown;
	try {
		first = JSON.parse(firstLine ?? "");
	} catch {
		throw new Error("events.jsonl is not a room log.");
	}
	if (
		!isRecord(first) ||
		!isRecord(first.payload) ||
		typeof first.payload.gameId !== "string"
	) {
		throw new Error("events.jsonl is not a room log.");
	}
	return first.payload.gameId;
};

const gameIdFrom = (envelopes: readonly Envelope[]): string => {
	const [first] = envelopes;
	if (
		first?.type !== "core.room-created" ||
		!isRecord(first.payload) ||
		typeof first.payload.gameId !== "string"
	) {
		throw new Error("events.jsonl is not a room log.");
	}
	return first.payload.gameId;
};

const produceCharacter = async (
	campaignFolder: string,
	name: string,
	requestedGameId: string | undefined = "draw-steel"
): Promise<SnapshotDocumentV1> => {
	let gameId = requestedGameId;
	try {
		gameId = await campaignGameId(campaignFolder);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const game = games.get(gameId);
	if (game === undefined) {
		throw new Error(`Unknown game '${gameId}'.`);
	}
	const bytes = await readNamedCharacter(campaignFolder, name);
	const validation = game.validate(bytes);
	if (!validation.ok) {
		throw new Error(
			validation.errors[0]?.message ?? "Character file is invalid."
		);
	}
	const contribution = game.snapshotCharacter(bytes, name);
	return validateProducedDocument({
		artifactType: "character",
		card: contribution.card,
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		sections: contribution.sections,
	});
};

const produceLog = async (
	campaignFolder: string,
	roomName: string
): Promise<SnapshotDocumentV1> => {
	const envelopes = await readLog(campaignFolder);
	const gameId = gameIdFrom(envelopes);
	const game = games.get(gameId);
	if (game === undefined) {
		throw new Error(`Unknown game '${gameId}'.`);
	}
	const fold = createTableFold(game.viewEntry, gameId, "publish");
	const entries: Extract<
		SnapshotDocumentV1,
		{ readonly artifactType: "log" }
	>["entries"][number][] = [];
	for (const envelope of envelopes) {
		const line = fold.apply(envelope);
		if (envelope.type === CORE_MAP_LOADED) {
			const map = readMapLoadedPayload(envelope.payload);
			if (map === null) {
				throw new Error(`Map loaded at event #${envelope.seq} is invalid.`);
			}
			entries.push({ block: mapGrid(map), timestamp: envelope.timestamp });
		} else if (line !== null) {
			entries.push({
				block: { runs: line.runs, type: "text" },
				timestamp: envelope.timestamp,
			});
		}
	}
	const dates = [
		...new Set(envelopes.map(({ timestamp }) => timestamp.slice(0, 10))),
	];
	const firstDate = dates[0] ?? "unknown";
	const lastDate = dates.at(-1) ?? firstDate;
	return validateProducedDocument({
		artifactType: "log",
		card: {
			accentHint: "primary",
			description:
				firstDate === lastDate ? firstDate : `${firstDate} – ${lastDate}`,
			fields: [
				{ label: "Events", value: String(envelopes.length) },
				{ label: "Days", value: String(dates.length) },
			],
			title: roomName,
		},
		entries,
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	});
};

const readNamedMap = async (
	campaignFolder: string,
	name: string
): Promise<BattleMap> => {
	const fileName = name.endsWith(MAP_FILE_EXTENSION)
		? name
		: `${name}${MAP_FILE_EXTENSION}`;
	const candidate = await resolveCampaignFile(
		name,
		path.join(campaignFolder, MAP_DIRECTORY, fileName)
	);
	try {
		const parsed = parseMapFile(await readFile(candidate));
		if (!parsed.ok) {
			throw new Error(parsed.errors.map(({ message }) => message).join(" "));
		}
		return parsed.map;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const directory = path.join(campaignFolder, MAP_DIRECTORY);
	let directoryEntries: string[];
	try {
		directoryEntries = await readdir(directory);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new Error(`Map '${name}' was not found in the campaign folder.`, {
				cause: error,
			});
		}
		throw error;
	}
	const fileNames = directoryEntries
		.filter((entry) => entry.endsWith(MAP_FILE_EXTENSION))
		.toSorted();
	const maps = await Promise.all(
		fileNames.map(async (entry) =>
			parseMapFile(await readFile(path.join(directory, entry)))
		)
	);
	const found = maps.find((parsed) => parsed.ok && parsed.map.name === name);
	if (found === undefined || !found.ok) {
		throw new Error(`Map '${name}' was not found in the campaign folder.`);
	}
	return found.map;
};

const produceMap = async (
	campaignFolder: string,
	name: string
): Promise<SnapshotDocumentV1> => {
	const map = await readNamedMap(campaignFolder, name);
	const dimensions = mapDimensions(map);
	return validateProducedDocument({
		artifactType: "map",
		card: {
			accentHint: "muted",
			description: "Terrain map",
			fields: [
				{
					label: "Dimensions",
					value: `${dimensions.width}×${dimensions.height}`,
				},
			],
			title: map.name,
		},
		map: mapGrid(map),
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	});
};

/** Folds campaign data and game knowledge into the pinned, game-blind v1 wire. */
export const produceSnapshotDocument = async (
	type: SnapshotArtifactType,
	campaignFolder: string,
	name: string,
	requestedGameId?: string
): Promise<SnapshotDocumentV1> => {
	if (type === "character") {
		return await produceCharacter(campaignFolder, name, requestedGameId);
	}
	if (type === "log") {
		return await produceLog(campaignFolder, name);
	}
	return await produceMap(campaignFolder, name);
};
