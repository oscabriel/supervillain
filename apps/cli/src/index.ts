#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
	init as drawSteelInit,
} from "@supervillain/draw-steel/model";
import { view as drawSteelView } from "@supervillain/draw-steel/view";
import { decide as fakeDecide } from "@supervillain/fake/authority";
import { content as fakeContent } from "@supervillain/fake/content";
import { apply as fakeApply, init as fakeInit } from "@supervillain/fake/model";
import { view as fakeView } from "@supervillain/fake/view";
import { loadOrCreateIdentity } from "@supervillain/identity";
import { InProcessRoomStore, RoomHost } from "@supervillain/room-host";
import {
	connectRoomStore,
	isValidRoomName,
	registerRoom,
	serveRoomStore,
} from "@supervillain/room-wire";
import type { RegistrationReceipt } from "@supervillain/room-wire";
import { attachLocalTty } from "@supervillain/session";
import { createLocalTtyRenderer, runTable } from "@supervillain/table";
import {
	DialTimeoutError,
	openWsDialer,
	SelfDialError,
} from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";

const USAGE = `Usage:
  supervillain create <campaign-folder> [--game <id>] [--name <room> [--gateway <addr>]]
  supervillain join <room-ref>
  supervillain publish
  supervillain character new <campaign-folder> <name> [--game <id>]
  supervillain character check <campaign-folder> [file] [--game <id>]
  supervillain character list <campaign-folder> [--game <id>]
  supervillain map check <campaign-folder> [file]
  supervillain map list <campaign-folder>
  supervillain campaign info <campaign-folder>

  --name registers the room at a gateway so players can ssh in; the gateway
  address comes from --gateway or SUPERVILLAIN_GATEWAY.`;

const hostRegistry: HostRegistry = {
	get: (gameId) => {
		if (gameId === "fake") {
			return {
				authority: { decide: fakeDecide },
				model: { apply: fakeApply, init: fakeInit },
			} as never;
		}
		return gameId === "draw-steel"
			? ({
					authority: { decide: drawSteelDecide },
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
	const configRoot =
		process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	const identity = await loadOrCreateIdentity(
		path.join(configRoot, "supervillain")
	);
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
	let receipt: RegistrationReceipt | undefined;
	if (typeof roomName === "string") {
		if (!isValidRoomName(roomName)) {
			console.error(
				"Room names are 1-32 lowercase letters, digits, and hyphens."
			);
			await listener.close();
			return 1;
		}
		const gatewayAddress =
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
		try {
			receipt = await registerRoom(
				openWsDialer({
					secretKeyHex: identity.secretKeyHex,
					url: gatewayAddress,
				}),
				{ address: listener.url, name: roomName }
			);
		} catch (error) {
			console.error(
				error instanceof Error
					? error.message
					: "Could not register the room at the gateway."
			);
			await listener.close();
			return 1;
		}
	}
	const server = serveRoomStore(listener, store, {
		info: { gameId, label: roomLabel },
		trustedStampers: receipt === undefined ? undefined : [receipt.gatewayId],
	});
	await writeFile(path.join(campaignFolder, "door.txt"), `${listener.url}\n`);
	const sshDoor =
		receipt === undefined || typeof roomName !== "string"
			? ""
			: `  ssh ${receipt.sshPort === 22 ? "" : `-p ${receipt.sshPort} `}${roomName}@${receipt.sshHost}\n`;
	process.stdout.write(
		`your table is live. summon your players:\n\n  supervillain join ${listener.url}\n${sshDoor}\n`
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
	await server.close();
	await listener.close();
	return 0;
};

const join = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: { help: { short: "h", type: "boolean" } },
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
	const [roomRef] = positionals;
	if (roomRef === undefined || positionals.length !== 1) {
		console.error("join requires one room ref.");
		return 1;
	}
	const configRoot =
		process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	const identity = await loadOrCreateIdentity(
		path.join(configRoot, "supervillain")
	);
	const actor = identity.publicKeyHex;
	let store: Awaited<ReturnType<typeof connectRoomStore>>;
	try {
		store = await connectRoomStore(
			openWsDialer({ secretKeyHex: identity.secretKeyHex, url: roomRef })
		);
	} catch (error) {
		if (error instanceof SelfDialError) {
			console.error(
				"that's your own table — you're already hosting it. to sit as a player, use the ssh door."
			);
		} else {
			console.error("Could not reach that room. Is the GM's table live?");
			if (!(error instanceof DialTimeoutError)) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
		return 1;
	}
	const info = await store.info();
	const entry = gatewayRegistry.get(info.gameId);
	if (entry === undefined) {
		console.error(`Unknown game '${info.gameId}'.`);
		await store.close();
		return 1;
	}
	const claim = await store.submit({
		actor,
		command: { type: "core.claim-seat" },
	});
	if ("rejected" in claim) {
		console.error(claim.message);
		await store.close();
		return 1;
	}
	await runTable({
		createRenderer: createLocalTtyRenderer,
		entry,
		gameId: info.gameId,
		roomLabel: info.label,
		session: attachLocalTty({ actor }),
		store,
	});
	await store.close();
	return 0;
};

const main = async (args: readonly string[]): Promise<number> => {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(USAGE);
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
