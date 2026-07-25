#!/usr/bin/env bun
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
	isRecord,
	MAP_DIRECTORY,
	MAP_FILE_EXTENSION,
	parseMapFile,
	validateMapFile,
} from "@supervillain/core";
import type {
	BattleMap,
	GameContent,
	GatewayRegistry,
	HostRegistry,
	RoomStore,
} from "@supervillain/core";
import { decide as drawSteelDecide } from "@supervillain/draw-steel/authority";
import {
	content as drawSteelContent,
	intake as drawSteelIntake,
} from "@supervillain/draw-steel/content";
import {
	apply as drawSteelApply,
	eventTypes as drawSteelEventTypes,
	init as drawSteelInit,
} from "@supervillain/draw-steel/model";
import { view as drawSteelView } from "@supervillain/draw-steel/view";
import { decide as fakeDecide } from "@supervillain/fake/authority";
import { content as fakeContent } from "@supervillain/fake/content";
import {
	apply as fakeApply,
	eventTypes as fakeEventTypes,
	init as fakeInit,
} from "@supervillain/fake/model";
import { view as fakeView } from "@supervillain/fake/view";
import {
	loadOrCreateIdentity,
	openSshPrivateKey,
} from "@supervillain/identity";
import { InProcessRoomStore, RoomHost } from "@supervillain/room-host";
import {
	isValidRoomName,
	openHostPipe,
	ROOM_NAME_RULE,
	serveRoomStore,
} from "@supervillain/room-wire";
import type { HostPipe, HostPipeAttachment } from "@supervillain/room-wire";
import { attachLocalTty } from "@supervillain/session";
import { createLocalTtyRenderer, runTable } from "@supervillain/table";
import { openWsDialer } from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";

const USAGE = `Usage:
  supervillain create <campaign-folder> [--game <id>] [--name <room> [--gateway <addr>]]
  supervillain join <room> [--gateway <url>] [--ssh-port <port>]
  supervillain publish
  supervillain key show
  supervillain character new <campaign-folder> <name> [--game <id>]
  supervillain character check <campaign-folder> [file] [--game <id>]
  supervillain character list <campaign-folder> [--game <id>]
  supervillain map check <campaign-folder> [file]
  supervillain map list <campaign-folder>
  supervillain campaign info <campaign-folder>

  --name registers the room at a gateway so players can ssh in; the gateway
  address comes from --gateway or SUPERVILLAIN_GATEWAY. The room name is held
  by this machine's key, so hosting the same name from another machine needs
  key linking, which is not built yet.

  join opens an ordinary ssh session to that same gateway with this machine's
  key, and the gateway resolves the room name. It is a convenience wrapper
  over 'ssh <room>@<gateway>' — nothing more. Joining a room you host yourself
  is just another session at your own table: your key already holds the GM
  seat, so you sit back down in it.`;

/** Credentials live in per-machine config, never in the campaign folder — the
 * folder moves between machines and backups; the key must not (ADR-0012). */
const configFolder = (): string =>
	path.join(
		process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
		"supervillain"
	);

// Mirrors apps/cli/package.json's version. A compiled binary carries no
// package.json to read at runtime, so this is the CI smoke build's minimum
// liveness check (`supervillain --version`) for platforms where the fuller
// release smoke can't run.
const CLI_VERSION = "0.0.0";

/** The SSH default. A hosted gateway answers on it; a self-hosted one usually
 * does not, which is what --ssh-port is for. */
const DEFAULT_SSH_PORT = 22;

const hostRegistry: HostRegistry = {
	get: (gameId) => {
		if (gameId === "fake") {
			return {
				authority: { decide: fakeDecide },
				grammar: { eventTypes: fakeEventTypes },
				model: { apply: fakeApply, init: fakeInit },
			} as never;
		}
		return gameId === "draw-steel"
			? ({
					authority: { decide: drawSteelDecide },
					grammar: { eventTypes: drawSteelEventTypes },
					model: { apply: drawSteelApply, init: drawSteelInit },
				} as never)
			: undefined;
	},
};
const gatewayRegistry: GatewayRegistry = {
	get: (gameId) => {
		if (gameId === "fake") {
			return {
				model: { apply: fakeApply, init: fakeInit },
				view: fakeView,
			} as never;
		}
		return gameId === "draw-steel"
			? ({
					model: { apply: drawSteelApply, init: drawSteelInit },
					view: drawSteelView,
				} as never)
			: undefined;
	},
};

interface Intake {
	readonly directory: string;
	readonly command: (fileName: string, text: string) => unknown;
}

interface RegisteredContent extends GameContent {
	readonly intake?: Intake;
	readonly template?: (name: string) => string;
}

const contentRegistry = new Map<string, RegisteredContent>([
	["fake", fakeContent],
	[
		"draw-steel",
		{
			...drawSteelContent,
			intake: drawSteelIntake,
		},
	],
]);

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

interface RoomLogSummary {
	readonly eventCount: number;
	readonly gameId: string;
}

interface CharacterFileResult {
	readonly fileName: string;
	readonly message: string;
	readonly name?: string;
	readonly ok: boolean;
}

const readRoomLog = async (
	campaignFolder: string
): Promise<RoomLogSummary | null> => {
	let text: string;
	try {
		text = await readFile(path.join(campaignFolder, "events.jsonl"), "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const lines = text.split(/\r?\n/u);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const [firstLine] = lines;
	let firstEvent: unknown;
	try {
		firstEvent = JSON.parse(firstLine ?? "");
	} catch {
		throw new Error("events.jsonl is not a room log.");
	}
	if (!isRecord(firstEvent) || !isRecord(firstEvent.payload)) {
		throw new Error("events.jsonl is not a room log.");
	}
	const { gameId } = firstEvent.payload;
	if (typeof gameId !== "string") {
		throw new TypeError("events.jsonl is not a room log.");
	}
	return { eventCount: lines.length, gameId };
};

const resolveContent = async (
	campaignFolder: string,
	requestedGameId: string | undefined
): Promise<{ readonly entry: RegisteredContent; readonly gameId: string }> => {
	const roomLog = await readRoomLog(campaignFolder);
	const gameId = roomLog?.gameId ?? requestedGameId ?? "draw-steel";
	const entry = contentRegistry.get(gameId);
	if (entry === undefined) {
		throw new Error(`Unknown game '${gameId}'.`);
	}
	return { entry, gameId };
};

const characterFileNames = async (
	campaignFolder: string
): Promise<readonly string[]> => {
	const directory = path.join(campaignFolder, "characters");
	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.toSorted();
};

const inspectCharacterFile = async (
	filePath: string,
	fileName: string,
	entry: RegisteredContent
): Promise<CharacterFileResult> => {
	let bytes: Uint8Array;
	try {
		bytes = await readFile(filePath);
	} catch (error) {
		let message: string;
		if (isNodeError(error) && error.code === "ENOENT") {
			message = "file not found.";
		} else {
			message = error instanceof Error ? error.message : String(error);
		}
		return { fileName, message, ok: false };
	}
	const result = entry.validate(bytes);
	if (!result.ok) {
		return {
			fileName,
			message: result.errors[0]?.message ?? "Character file is invalid.",
			ok: false,
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { fileName, message: "ok", ok: true };
	}
	return {
		fileName,
		message: "ok",
		name:
			isRecord(value) && typeof value.name === "string"
				? value.name
				: undefined,
		ok: true,
	};
};

const inspectCharacterDirectory = async (
	campaignFolder: string,
	entry: RegisteredContent,
	fileNames: readonly string[]
): Promise<readonly CharacterFileResult[]> =>
	await Promise.all(
		fileNames.map((fileName) =>
			inspectCharacterFile(
				path.join(campaignFolder, "characters", fileName),
				fileName,
				entry
			)
		)
	);

const resolveCharacterFile = async (
	campaignFolder: string,
	file: string
): Promise<string> => {
	try {
		await access(file);
		return file;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	return path.join(campaignFolder, "characters", file);
};

const characterNew = async (
	campaignFolder: string,
	name: string,
	requestedGameId: string | undefined
): Promise<number> => {
	const trimmedName = name.trim();
	if (trimmedName.length === 0 || trimmedName.length > 60) {
		console.error(
			"Field 'name' must be a non-empty string of at most 60 characters."
		);
		return 1;
	}
	const { entry } = await resolveContent(campaignFolder, requestedGameId);
	if (entry.template === undefined) {
		console.error("This game does not provide a character template.");
		return 1;
	}
	const slug = trimmedName
		.toLowerCase()
		.replaceAll(" ", "-")
		.replaceAll(/[^a-z0-9-]/gu, "")
		.replaceAll(/-+/gu, "-")
		.replaceAll(/^-|-$/gu, "");
	if (slug.length === 0) {
		console.error(
			"Character name has no filename-safe characters; pass an ASCII name."
		);
		return 1;
	}
	const directory = path.join(campaignFolder, "characters");
	const filePath = path.join(directory, `${slug}.json`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(filePath, entry.template(trimmedName), { flag: "wx" });
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			console.error(`${filePath} already exists.`);
			return 1;
		}
		throw error;
	}
	console.log(filePath);
	return 0;
};

const characterCheck = async (
	campaignFolder: string,
	file: string | undefined,
	requestedGameId: string | undefined
): Promise<number> => {
	const { entry } = await resolveContent(campaignFolder, requestedGameId);
	let results: readonly CharacterFileResult[];
	if (file === undefined) {
		const fileNames = await characterFileNames(campaignFolder);
		if (fileNames.length === 0) {
			console.log("no character files.");
			return 0;
		}
		results = await inspectCharacterDirectory(campaignFolder, entry, fileNames);
	} else {
		const filePath = await resolveCharacterFile(campaignFolder, file);
		results = [
			await inspectCharacterFile(filePath, path.basename(filePath), entry),
		];
	}
	for (const result of results) {
		console.log(`${result.fileName}: ${result.message}`);
	}
	return results.every((result) => result.ok) ? 0 : 1;
};

const printCharacterRoster = async (
	campaignFolder: string,
	entry: RegisteredContent,
	fileNames: readonly string[]
): Promise<void> => {
	const results = await inspectCharacterDirectory(
		campaignFolder,
		entry,
		fileNames
	);
	for (const result of results) {
		console.log(
			`${result.ok && result.name !== undefined ? result.name : "invalid"} — ${result.fileName}`
		);
	}
};

const characterList = async (
	campaignFolder: string,
	requestedGameId: string | undefined
): Promise<number> => {
	const { entry } = await resolveContent(campaignFolder, requestedGameId);
	const fileNames = await characterFileNames(campaignFolder);
	if (fileNames.length === 0) {
		console.log("no character files.");
		return 0;
	}
	await printCharacterRoster(campaignFolder, entry, fileNames);
	return 0;
};

const character = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		const parseableArgs =
			args[0] === "new" && args[2]?.startsWith("-")
				? [...args.slice(0, 2), ...args.slice(3), "--", args[2]]
				: [...args];
		parsed = parseArgs({
			allowPositionals: true,
			args: parseableArgs,
			options: { game: { type: "string" } },
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [subcommand, campaignFolder, value] = positionals;
	const requestedGameId =
		typeof parsed.values.game === "string" ? parsed.values.game : undefined;
	try {
		if (subcommand === "new") {
			if (
				campaignFolder === undefined ||
				value === undefined ||
				positionals.length !== 3
			) {
				console.error("character new requires a campaign folder and a name.");
				return 1;
			}
			return await characterNew(campaignFolder, value, requestedGameId);
		}
		if (subcommand === "check") {
			if (campaignFolder === undefined || positionals.length > 3) {
				console.error(
					"character check requires a campaign folder and optional file."
				);
				return 1;
			}
			return await characterCheck(campaignFolder, value, requestedGameId);
		}
		if (subcommand === "list") {
			if (campaignFolder === undefined || positionals.length !== 2) {
				console.error("character list requires a campaign folder.");
				return 1;
			}
			return await characterList(campaignFolder, requestedGameId);
		}
		console.error("character requires new, check, or list.");
		return 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

interface MapFileResult {
	readonly fileName: string;
	readonly map?: BattleMap;
	readonly messages: readonly string[];
	readonly ok: boolean;
}

const mapFileNames = async (
	campaignFolder: string
): Promise<readonly string[]> => {
	const directory = path.join(campaignFolder, MAP_DIRECTORY);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return entries
		.filter(
			(entry) => entry.isFile() && entry.name.endsWith(MAP_FILE_EXTENSION)
		)
		.map((entry) => entry.name)
		.toSorted();
};

const readMapBytes = async (filePath: string): Promise<Uint8Array | string> => {
	try {
		return await readFile(filePath);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return "file not found.";
		}
		return error instanceof Error ? error.message : String(error);
	}
};

const checkMapFile = async (
	filePath: string,
	fileName: string
): Promise<MapFileResult> => {
	const bytes = await readMapBytes(filePath);
	if (typeof bytes === "string") {
		return { fileName, messages: [bytes], ok: false };
	}
	const result = validateMapFile(bytes);
	return result.ok
		? { fileName, messages: ["ok"], ok: true }
		: {
				fileName,
				messages: result.errors.map((error) => error.message),
				ok: false,
			};
};

const describeMapFile = async (
	filePath: string,
	fileName: string
): Promise<MapFileResult> => {
	const bytes = await readMapBytes(filePath);
	if (typeof bytes === "string") {
		return { fileName, messages: [bytes], ok: false };
	}
	const parsed = parseMapFile(bytes);
	return parsed.ok
		? { fileName, map: parsed.map, messages: ["ok"], ok: true }
		: {
				fileName,
				messages: parsed.errors.map((error) => error.message),
				ok: false,
			};
};

const resolveMapFile = async (
	campaignFolder: string,
	file: string
): Promise<string> => {
	try {
		await access(file);
		return file;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const fileName = file.endsWith(MAP_FILE_EXTENSION)
		? file
		: `${file}${MAP_FILE_EXTENSION}`;
	return path.join(campaignFolder, MAP_DIRECTORY, fileName);
};

const mapCheck = async (
	campaignFolder: string,
	file: string | undefined
): Promise<number> => {
	let results: readonly MapFileResult[];
	if (file === undefined) {
		const fileNames = await mapFileNames(campaignFolder);
		if (fileNames.length === 0) {
			console.log("no map files.");
			return 0;
		}
		results = await Promise.all(
			fileNames.map((fileName) =>
				checkMapFile(
					path.join(campaignFolder, MAP_DIRECTORY, fileName),
					fileName
				)
			)
		);
	} else {
		const filePath = await resolveMapFile(campaignFolder, file);
		results = [await checkMapFile(filePath, path.basename(filePath))];
	}
	for (const result of results) {
		for (const message of result.messages) {
			console.log(`${result.fileName}: ${message}`);
		}
	}
	return results.every((result) => result.ok) ? 0 : 1;
};

const mapList = async (campaignFolder: string): Promise<number> => {
	const fileNames = await mapFileNames(campaignFolder);
	if (fileNames.length === 0) {
		console.log("no map files.");
		return 0;
	}
	const results = await Promise.all(
		fileNames.map((fileName) =>
			describeMapFile(
				path.join(campaignFolder, MAP_DIRECTORY, fileName),
				fileName
			)
		)
	);
	for (const result of results) {
		if (result.map === undefined) {
			console.log(`invalid — ${result.fileName}`);
			continue;
		}
		const width = [...(result.map.rows[0] ?? "")].length;
		console.log(
			`${result.map.name} — ${result.fileName} (${width}×${result.map.rows.length})`
		);
	}
	return 0;
};

const map = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: {},
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [subcommand, campaignFolder, file] = positionals;
	try {
		if (subcommand === "check") {
			if (campaignFolder === undefined || positionals.length > 3) {
				console.error(
					"map check requires a campaign folder and optional file."
				);
				return 1;
			}
			return await mapCheck(campaignFolder, file);
		}
		if (subcommand === "list") {
			if (campaignFolder === undefined || positionals.length !== 2) {
				console.error("map list requires a campaign folder.");
				return 1;
			}
			return await mapList(campaignFolder);
		}
		console.error("map requires check or list.");
		return 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

const campaignInfo = async (campaignFolder: string): Promise<number> => {
	const roomLog = await readRoomLog(campaignFolder);
	if (roomLog === null) {
		console.log("no room yet.");
	} else {
		console.log(`game: ${roomLog.gameId}`);
		console.log(`events: ${roomLog.eventCount}`);
	}
	const fileNames = await characterFileNames(campaignFolder);
	console.log(`characters: ${fileNames.length}`);
	if (fileNames.length === 0) {
		return 0;
	}
	const gameId = roomLog?.gameId ?? "draw-steel";
	const entry = contentRegistry.get(gameId);
	if (entry === undefined) {
		throw new Error(`Unknown game '${gameId}'.`);
	}
	await printCharacterRoster(campaignFolder, entry, fileNames);
	return 0;
};

const campaign = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: {},
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [subcommand, campaignFolder] = positionals;
	if (
		subcommand !== "info" ||
		campaignFolder === undefined ||
		positionals.length !== 2
	) {
		console.error("campaign info requires a campaign folder.");
		return 1;
	}
	try {
		return await campaignInfo(campaignFolder);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

const runIntake = async (
	campaignFolder: string,
	gameId: string,
	actor: string,
	store: RoomStore
): Promise<void> => {
	const intake = contentRegistry.get(gameId)?.intake;
	if (intake === undefined) {
		return;
	}
	const directory = path.join(campaignFolder, intake.directory);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
	const fileNames = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.toSorted();
	for (const fileName of fileNames) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- deterministic intake must submit sorted files in order.
		const text = await readFile(path.join(directory, fileName), "utf-8");
		// oxlint-disable-next-line eslint/no-await-in-loop -- each file's event must be durably ordered before the next.
		const result = await store.submit({
			actor,
			command: intake.command(fileName, text),
		});
		if ("rejected" in result) {
			console.error(`${fileName}: ${result.message}`);
		}
	}
};

/**
 * What `create` tells the GM once the table is up. There are two honest
 * answers and the split is ADR-0012's three postures: a registered room has a
 * door players can reach; a table with no gateway is local to this machine and
 * says so, because `join` no longer dials anything (NQ-7).
 */
const summonNotice = (options: {
	readonly attachment: HostPipeAttachment | undefined;
	readonly gatewayAddress: string | undefined;
	readonly roomName: string | undefined;
}): string => {
	const { attachment, gatewayAddress, roomName } = options;
	if (attachment === undefined || roomName === undefined) {
		return "your table is live. this machine is the Host.\n\nno room is registered, so this table is local to this machine. pass\n--name <room> --gateway <url> to open a door for players.\n\n";
	}
	const atDefaultPort = attachment.sshPort === DEFAULT_SSH_PORT;
	const portFlag = atDefaultPort ? "" : `-p ${attachment.sshPort} `;
	const gatewayFlag =
		gatewayAddress === undefined ? "" : ` --gateway ${gatewayAddress}`;
	// The pipe URL's port is not the door's, so a non-default door has to be
	// spelled out for the player too.
	const sshPortFlag = atDefaultPort ? "" : ` --ssh-port ${attachment.sshPort}`;
	return `your table is live. summon your players:\n\n  ssh ${portFlag}${roomName}@${attachment.sshHost}\n  supervillain join ${roomName}${gatewayFlag}${sshPortFlag}\n\nthis name is held by this machine's key. hosting it from another machine\nneeds key linking, which is not built yet.\n\n`;
};

const create = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: {
				game: { type: "string" },
				gateway: { type: "string" },
				help: { short: "h", type: "boolean" },
				name: { type: "string" },
			},
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (parsed.values.help) {
		console.log(USAGE);
		return 0;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [campaignFolder] = positionals;
	if (campaignFolder === undefined || positionals.length !== 1) {
		console.error("create requires one campaign folder.");
		return 1;
	}
	const gameId =
		typeof parsed.values.game === "string" ? parsed.values.game : "draw-steel";
	const entry = gatewayRegistry.get(gameId);
	if (hostRegistry.get(gameId) === undefined || entry === undefined) {
		console.error(`Unknown game '${gameId}'.`);
		return 1;
	}
	const identity = await loadOrCreateIdentity(configFolder());
	const actor = identity.publicKeyHex;
	const host = await RoomHost.open({
		actor,
		campaignFolder,
		gameId,
		registry: hostRegistry,
	});
	const store = new InProcessRoomStore(host);
	const roomLabel = path.basename(path.resolve(campaignFolder));
	const listener = await startWsListener({
		host: process.env.SUPERVILLAIN_HOST_BIND,
		secretKeyHex: identity.secretKeyHex,
	});
	const roomName = parsed.values.name;
	let attachment: HostPipeAttachment | undefined;
	let pipe: HostPipe | undefined;
	let gatewayAddress: string | undefined;
	if (typeof roomName === "string") {
		if (!isValidRoomName(roomName)) {
			console.error(ROOM_NAME_RULE);
			await listener.close();
			return 1;
		}
		gatewayAddress =
			typeof parsed.values.gateway === "string"
				? parsed.values.gateway
				: process.env.SUPERVILLAIN_GATEWAY;
		if (gatewayAddress === undefined) {
			console.error(
				"--name needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY."
			);
			await listener.close();
			return 1;
		}
		// The Host dials out and keeps dialing (ADR-0012): the gateway never
		// reaches back for this machine, so no port here is ever opened to it.
		pipe = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: identity.secretKeyHex,
				url: gatewayAddress,
			}),
			rooms: [{ info: { gameId, label: roomLabel }, name: roomName, store }],
		});
		try {
			attachment = await pipe.attached;
		} catch (error) {
			console.error(
				error instanceof Error
					? error.message
					: "Could not register the room at the gateway."
			);
			await pipe.close();
			await listener.close();
			return 1;
		}
	}
	const server = serveRoomStore(listener, store, {
		info: { gameId, label: roomLabel },
	});
	await writeFile(path.join(campaignFolder, "door.txt"), `${listener.url}\n`);
	process.stdout.write(
		summonNotice({
			attachment,
			gatewayAddress,
			roomName: typeof roomName === "string" ? roomName : undefined,
		})
	);
	await runIntake(campaignFolder, gameId, actor, store);
	const session = attachLocalTty({ actor });
	await runTable({
		createRenderer: createLocalTtyRenderer,
		entry,
		gameId,
		roomLabel,
		session,
		store,
	});
	await pipe?.close();
	await server.close();
	await listener.close();
	return 0;
};

/**
 * The gateway's SSH hostname, read out of the same URL `create --gateway`
 * dials. Only the host travels: the URL's port is the Host pipe's, never the
 * door's.
 */
const gatewaySshHost = (address: string): string | undefined => {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return undefined;
	}
	// URL keeps IPv6 literals bracketed; ssh wants them bare.
	const host = url.hostname.replaceAll(/^\[|\]$/gu, "");
	return host.length === 0 ? undefined : host;
};

const sshPortFrom = (value: string | undefined): number | undefined => {
	if (value === undefined) {
		return DEFAULT_SSH_PORT;
	}
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65_535
		? port
		: undefined;
};

/** Hands the terminal to `ssh` and reports how it came back. */
const runSsh = (args: readonly string[]): Promise<number> =>
	// oxlint-disable-next-line promise/avoid-new -- child_process is event-shaped.
	new Promise<number>((resolve, reject) => {
		const child = spawn("ssh", [...args], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolve(signal === null ? (code ?? 1) : 1)
		);
	});

interface JoinTarget {
	readonly host: string;
	readonly port: number;
	readonly roomName: string;
}

/** The command line a player could have typed themselves — printed whenever
 * the CLI cannot run it for them. `join` adds convenience, not capability
 * (ADR-0012, NQ-7), so the bare form is never a secret. */
const bareSshLine = (target: JoinTarget): string =>
	`  ssh ${target.port === DEFAULT_SSH_PORT ? "" : `-p ${target.port} `}${target.roomName}@${target.host}`;

const resolveJoinTarget = (
	roomName: string,
	values: { readonly gateway?: string; readonly sshPort?: string }
): JoinTarget | undefined => {
	if (!isValidRoomName(roomName)) {
		console.error(ROOM_NAME_RULE);
		return undefined;
	}
	const gatewayAddress = values.gateway ?? process.env.SUPERVILLAIN_GATEWAY;
	if (gatewayAddress === undefined) {
		console.error(
			"join needs a gateway: pass --gateway <url> or set SUPERVILLAIN_GATEWAY."
		);
		return undefined;
	}
	const host = gatewaySshHost(gatewayAddress);
	if (host === undefined) {
		console.error(`'${gatewayAddress}' is not a gateway URL.`);
		return undefined;
	}
	const port = sshPortFrom(values.sshPort);
	if (port === undefined) {
		console.error("--ssh-port must be a port number between 1 and 65535.");
		return undefined;
	}
	return { host, port, roomName };
};

/**
 * `join` is a thin front door: an ordinary SSH session to the configured
 * gateway, carrying this machine's key, with the room name as the SSH user
 * (ADR-0012, NQ-7). No room is dialed and no client protocol ships — an
 * unknown or offline name is answered by the gateway's own lobby copy, not by
 * a connection error here.
 */
const join = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: {
				gateway: { type: "string" },
				help: { short: "h", type: "boolean" },
				"ssh-port": { type: "string" },
			},
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (parsed.values.help) {
		console.log(USAGE);
		return 0;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [roomName] = positionals;
	if (roomName === undefined || positionals.length !== 1) {
		console.error("join requires one room name.");
		return 1;
	}
	const target = resolveJoinTarget(roomName, {
		gateway:
			typeof parsed.values.gateway === "string"
				? parsed.values.gateway
				: undefined,
		sshPort:
			typeof parsed.values["ssh-port"] === "string"
				? parsed.values["ssh-port"]
				: undefined,
	});
	if (target === undefined) {
		return 1;
	}
	const folder = configFolder();
	const identity = await loadOrCreateIdentity(folder);
	// The key the Host pipe signs with, re-encoded for an ordinary ssh client.
	// It stays beside identity.json in per-machine config and never touches the
	// user's ~/.ssh — the CLI manages its own key, so it manages its own
	// host-key trust store too.
	const keyFile = path.join(folder, "id_ed25519");
	await writeFile(keyFile, openSshPrivateKey(identity), { mode: 0o600 });
	await chmod(keyFile, 0o600);
	const sshArgs = [
		"-i",
		keyFile,
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		// Quoted because ssh tokenizes an -o value on whitespace, and a home
		// directory is allowed to contain a space.
		`UserKnownHostsFile="${path.join(folder, "known_hosts")}"`,
		...(target.port === DEFAULT_SSH_PORT ? [] : ["-p", String(target.port)]),
		`${target.roomName}@${target.host}`,
	];
	try {
		return await runSsh(sshArgs);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.error(
				`join needs an ssh client on PATH. once you have one:\n\n${bareSshLine(target)}\n`
			);
			return 1;
		}
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

/**
 * The `key` noun. It shows the per-machine credential the Host proves itself
 * with — linking and retiring keys wait on ADR-0005's key-equivalence graph,
 * which has no implementation yet.
 */
const key = async (args: readonly string[]): Promise<number> => {
	const [subcommand, ...rest] = args;
	if (subcommand !== "show" || rest.length > 0) {
		console.error("key requires show.");
		return 1;
	}
	const folder = configFolder();
	const identity = await loadOrCreateIdentity(folder);
	console.log(`key:  ${identity.publicKeyHex}`);
	console.log(`file: ${path.join(folder, "identity.json")}`);
	console.log(
		"this key belongs to this machine, not to the campaign folder. linking a\nsecond machine to the same identity is not built yet."
	);
	return 0;
};

const main = async (args: readonly string[]): Promise<number> => {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	if (args.includes("--version")) {
		console.log(CLI_VERSION);
		return 0;
	}
	const [verb, ...rest] = args;
	if (verb === undefined) {
		console.error(USAGE);
		return 1;
	}
	if (verb === "campaign") {
		return await campaign(rest);
	}
	if (verb === "character") {
		return await character(rest);
	}
	if (verb === "create") {
		return await create(rest);
	}
	if (verb === "join") {
		return await join(rest);
	}
	if (verb === "key") {
		return await key(rest);
	}
	if (verb === "map") {
		return await map(rest);
	}
	if (verb === "publish") {
		console.error("publish arrives with a later release.");
		return 1;
	}
	console.error(`Unknown command '${verb}'.`);
	return 1;
};

process.exitCode = await main(process.argv.slice(2));
