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
	independenceNotice,
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
	openGatewayLink,
	openHostPipe,
	ROOM_NAME_RULE,
} from "@supervillain/room-wire";
import type {
	HostPipe,
	HostPipeAttachment,
	HostPipeEvent,
} from "@supervillain/room-wire";
import { attachLocalTty } from "@supervillain/session";
import { createSessionRenderer, runTable } from "@supervillain/table";
import {
	CertificateMismatchError,
	DialTimeoutError,
	openWsDialer,
} from "@supervillain/transport-ws";

import { runGatewayRole } from "./gateway-role.js";
import {
	forgetGateway,
	pinFilePath,
	pinGateway,
	plaintextWarning,
	resolveGatewayTarget,
} from "./gateways.js";
import type { GatewayTarget } from "./gateways.js";

const USAGE = `Usage:
  supervillain create <campaign-folder> [--game <id>] [--name <room> [--gateway <addr-or-pairing-code>]]
  supervillain join <room> [--gateway <addr-or-pairing-code>] [--ssh-port <port>]
  supervillain publish
  supervillain key show
  supervillain key link [<code>] [--gateway <addr>]
  supervillain key revoke <key> [--gateway <addr>]
  supervillain character new <campaign-folder> <name> [--game <id>]
  supervillain character check <campaign-folder> [file] [--game <id>]
  supervillain character list <campaign-folder> [--game <id>]
  supervillain map check <campaign-folder> [file]
  supervillain map list <campaign-folder>
  supervillain campaign info <campaign-folder>

Operator role (this same binary is the self-hosted gateway — ADR-0015):
  supervillain gateway serve [--state <dir>] [--ssh-host <name>]
                             [--ssh-port <port>] [--bind <host>]
                             [--broker-port <port>] [--broker-url <url>]
  supervillain gateway forget <url-or-pairing-code>

  --name registers the room at a gateway so players can ssh in; the gateway
  address comes from --gateway or SUPERVILLAIN_GATEWAY. That address is a
  wss:// URL, or the pairing code a self-hosted gateway prints — the same URL
  with its certificate fingerprint on the end. The first connection pins that
  certificate on this machine; a gateway that later serves a different one is
  refused rather than trusted. A room name is held by an identity, so to host
  it from a second machine, run 'key link' on the machine that already holds
  it and redeem the code on the new one. Retire a machine you no longer
  control with 'key revoke <key>' from one you do — it stops hosting and
  joining at once, and the rooms stay with your identity.

  join opens an ordinary ssh session to that same gateway with this machine's
  key, and the gateway resolves the room name. It is a convenience wrapper
  over 'ssh <room>@<gateway>' — nothing more. Joining a room you host yourself
  is just another session at your own table: your key already holds the GM
  seat, so you sit back down in it.

${independenceNotice}`;

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
	return `your table is live. summon your players:\n\n  ssh ${portFlag}${roomName}@${attachment.sshHost}\n  supervillain join ${roomName}${gatewayFlag}${sshPortFlag}\n\nthis name is held by your identity. to host it from another machine, run\n'supervillain key link' here and redeem the code there.\n\n`;
};

type HostRoom = Parameters<typeof openHostPipe>[0]["rooms"][number];

const DIALING_NOTICE_DELAY_MS = 1000;
const DIALING_STATUS_ATTEMPTS = 3;
const STILL_TRYING_DELAY_MS = 30_000;

const summarizeDialError = (message: string): string => {
	if (/connection refused|ECONNREFUSED/iu.test(message)) {
		return "connection refused";
	}
	if (/timed out|ETIMEDOUT/iu.test(message)) {
		return "timed out";
	}
	return message.split("\n", 1)[0]?.trim() || "connection failed";
};

/** Human-facing progress for interactive `create`. The pipe remains the sole
 * source of retry facts; this layer only throttles and phrases those events. */
const watchGatewayDial = (
	hostname: string
): {
	readonly onEvent: (event: HostPipeEvent) => void;
	readonly stop: () => void;
} => {
	let attempt = 0;
	let lastError: string | undefined;
	let lastReportedAttempt = 0;
	let lastReportedError: string | undefined;
	let noticeShown = false;
	let stopped = false;

	const reportCurrentStatus = (): void => {
		if (lastError === undefined) {
			return;
		}
		const summary = summarizeDialError(lastError);
		console.error(`attempt ${attempt} — ${summary}`);
		lastReportedAttempt = attempt;
		lastReportedError = summary;
	};
	const noticeTimer = setTimeout(() => {
		if (stopped) {
			return;
		}
		noticeShown = true;
		console.error(`dialing ${hostname}…`);
		reportCurrentStatus();
	}, DIALING_NOTICE_DELAY_MS);
	const stillTryingTimer = setTimeout(() => {
		if (!stopped) {
			console.error("still trying — Ctrl+C to stop");
		}
	}, STILL_TRYING_DELAY_MS);

	return {
		onEvent: (event): void => {
			if (event.kind !== "dialing") {
				return;
			}
			const { attempt: currentAttempt, lastError: currentLastError } = event;
			attempt = currentAttempt;
			lastError = currentLastError;
			if (!noticeShown || lastError === undefined) {
				return;
			}
			const summary = summarizeDialError(lastError);
			const errorChanged = summary !== lastReportedError;
			const enoughAttemptsPassed =
				attempt - lastReportedAttempt >= DIALING_STATUS_ATTEMPTS;
			if (errorChanged || enoughAttemptsPassed) {
				reportCurrentStatus();
			}
		},
		stop: (): void => {
			stopped = true;
			clearTimeout(noticeTimer);
			clearTimeout(stillTryingTimer);
		},
	};
};

/** The live pipe, or the one line explaining why there isn't one. Registration
 * fails for reasons a human fixes — a bad room name, a missing gateway, a
 * gateway whose certificate is not the pinned one — so every path out of here
 * is a sentence, never a stack trace. */
type Registration =
	| { readonly pipe: HostPipe; readonly attachment: HostPipeAttachment }
	| { readonly failed: string };

const gatewayDialRefusal = (error: CertificateMismatchError): string => {
	const { url } = error;
	const parsedUrl = new URL(url);
	const { origin } = parsedUrl;
	return [
		error.message,
		"",
		"If you rebuilt that gateway yourself, forget the old decision and pair again:",
		`  supervillain gateway forget ${origin}`,
		"This removes its entry from:",
		`  ${pinFilePath(configFolder())}`,
	].join("\n");
};

/**
 * Claims the room name at the gateway and holds the pipe open. Trust is settled
 * before the dial (ADR-0014): the address may be a pairing code carrying the
 * certificate this machine must find, and a pin that disagrees is a refusal
 * rather than a prompt. The pin is written only once the gateway has answered,
 * so a code that never connected leaves nothing behind to un-pair.
 */
const registerAtGateway = async (options: {
	readonly gatewayAddress: string | undefined;
	readonly room: HostRoom;
	readonly secretKeyHex: string;
}): Promise<Registration> => {
	if (!isValidRoomName(options.room.name)) {
		return { failed: ROOM_NAME_RULE };
	}
	if (options.gatewayAddress === undefined) {
		return {
			failed:
				"--name needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY.",
		};
	}
	let target: GatewayTarget;
	try {
		target = await resolveGatewayTarget(configFolder(), options.gatewayAddress);
	} catch (error) {
		return { failed: error instanceof Error ? error.message : String(error) };
	}
	const plaintext = plaintextWarning(target.url);
	if (plaintext !== undefined) {
		console.error(plaintext);
	}
	// The Host dials out and keeps dialing (ADR-0012): the gateway never
	// reaches back for this machine, so no port here is ever opened to it.
	const dialStatus = watchGatewayDial(new URL(target.url).hostname);
	const pipe = openHostPipe({
		dialer: openWsDialer({
			certificateFingerprint: target.fingerprint,
			secretKeyHex: options.secretKeyHex,
			url: target.url,
		}),
		onEvent: dialStatus.onEvent,
		rooms: [options.room],
	});
	let attachment: HostPipeAttachment;
	try {
		attachment = await pipe.attached;
	} catch (error) {
		dialStatus.stop();
		await pipe.close();
		let failed = "Could not register the room at the gateway.";
		if (error instanceof CertificateMismatchError) {
			failed = gatewayDialRefusal(error);
		} else if (error instanceof Error) {
			failed = error.message;
		}
		return { failed };
	}
	dialStatus.stop();
	if (target.pinOnSuccess && target.fingerprint !== undefined) {
		await pinGateway(configFolder(), target.origin, target.fingerprint);
	}
	return { attachment, pipe };
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
	const roomName = parsed.values.name;
	let attachment: HostPipeAttachment | undefined;
	let pipe: HostPipe | undefined;
	let gatewayAddress: string | undefined;
	if (typeof roomName === "string") {
		gatewayAddress =
			typeof parsed.values.gateway === "string"
				? parsed.values.gateway
				: process.env.SUPERVILLAIN_GATEWAY;
		const registration = await registerAtGateway({
			gatewayAddress,
			room: {
				// The roster the gateway resolves against its graph at every
				// registration — which is how this room learns about linking
				// that happened while it was offline (ADR-0013).
				actors: () => host.actors(),
				info: { gameId, label: roomLabel },
				name: roomName,
				store,
			},
			secretKeyHex: identity.secretKeyHex,
		});
		if ("failed" in registration) {
			console.error(registration.failed);
			return 1;
		}
		({ attachment, pipe } = registration);
	}
	process.stdout.write(
		summonNotice({
			attachment,
			gatewayAddress,
			roomName: typeof roomName === "string" ? roomName : undefined,
		})
	);
	await runIntake(campaignFolder, gameId, actor, store);
	const session = attachLocalTty({ actor });
	// The surface's half of ADR-0016: this process owns the local TTY, so it
	// mints the one renderer, lends it to the table, and destroys it after.
	const renderer = await createSessionRenderer(session);
	try {
		await runTable({
			entry,
			gameId,
			renderer,
			roomLabel,
			session,
			store,
		});
	} finally {
		if (!renderer.isDestroyed) {
			renderer.destroy();
		}
	}
	await pipe?.close();
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

const resolveJoinTarget = async (
	roomName: string,
	values: { readonly gateway?: string; readonly sshPort?: string }
): Promise<JoinTarget | undefined> => {
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
	let gatewayTarget: GatewayTarget;
	try {
		gatewayTarget = await resolveGatewayTarget(configFolder(), gatewayAddress);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return undefined;
	}
	const host = gatewaySshHost(gatewayTarget.url);
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
	const target = await resolveJoinTarget(roomName, {
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

const keyShow = async (): Promise<number> => {
	const folder = configFolder();
	const identity = await loadOrCreateIdentity(folder);
	console.log(`key:  ${identity.publicKeyHex}`);
	console.log(`file: ${path.join(folder, "identity.json")}`);
	console.log(
		"this key belongs to this machine, not to the campaign folder. to give a\nsecond machine the same identity, run 'supervillain key link' here."
	);
	return 0;
};

/** Both key verbs take the same `--gateway`, falling back to the environment.
 * An empty answer is a refusal, not a guess: the graph lives at one gateway and
 * picking one for the operator would pick their identity for them. */
const keyGatewayAddress = (
	values: ReturnType<typeof parseArgs>["values"]
): string =>
	typeof values.gateway === "string"
		? values.gateway
		: (process.env.SUPERVILLAIN_GATEWAY ?? "");

/** The one dial both key verbs ride: the Host pipe with no rooms on it. Trust
 * resolution and first-use pinning are the same path room registration uses. */
const openKeyConduit = async (
	gatewayAddress: string
): Promise<Awaited<ReturnType<typeof openGatewayLink>> | undefined> => {
	let target: GatewayTarget;
	try {
		target = await resolveGatewayTarget(configFolder(), gatewayAddress);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return undefined;
	}
	const plaintext = plaintextWarning(target.url);
	if (plaintext !== undefined) {
		console.error(plaintext);
	}
	const identity = await loadOrCreateIdentity(configFolder());
	try {
		const link = await openGatewayLink({
			dialer: openWsDialer({
				certificateFingerprint: target.fingerprint,
				secretKeyHex: identity.secretKeyHex,
				url: target.url,
			}),
		});
		if (target.pinOnSuccess && target.fingerprint !== undefined) {
			try {
				await pinGateway(configFolder(), target.origin, target.fingerprint);
			} catch (error) {
				await link.close();
				throw error;
			}
		}
		return link;
	} catch (error) {
		console.error("Could not reach that gateway.");
		if (error instanceof CertificateMismatchError) {
			console.error(gatewayDialRefusal(error));
		} else if (!(error instanceof DialTimeoutError)) {
			console.error(error instanceof Error ? error.message : String(error));
		}
		return undefined;
	}
};

/**
 * `key link` targets the **gateway**, which owns the key-equivalence graph
 * (ADR-0013's correction to ADR-0005). It rides the same outbound pipe the Host
 * dials — same dial, same authentication — with no rooms on it, so the
 * connection's authenticated key is the one being linked and no request on the
 * wire ever names somebody else's.
 */
const keyLink = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: { gateway: { type: "string" } },
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	if (positionals.length > 1) {
		console.error("key link takes at most one code.");
		return 1;
	}
	const gatewayAddress = keyGatewayAddress(parsed.values);
	if (gatewayAddress === "") {
		console.error(
			"key link needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY."
		);
		return 1;
	}
	const link = await openKeyConduit(gatewayAddress);
	if (link === undefined) {
		return 1;
	}
	try {
		const [code] = positionals;
		if (code === undefined) {
			const minted = await link.mintDeviceCode();
			if ("rejected" in minted) {
				console.error(minted.message);
				return 1;
			}
			console.log(`link code: ${minted.code}`);
			console.log(`expires:   ${minted.expiresAt}`);
			console.log(
				`\non the other machine, run:\n\n  supervillain key link ${minted.code}`
			);
			return 0;
		}
		const redeemed = await link.redeem(code);
		if ("rejected" in redeemed) {
			console.error(redeemed.message);
			return 1;
		}
		console.log(`linked: ${redeemed.linked}`);
		console.log(
			"this machine's key now answers for that identity. seats and rooms it\nholds are yours from here."
		);
		return 0;
	} finally {
		await link.close();
	}
};

/**
 * `key revoke` is the retire half of rotation (ADR-0012, NQ-3): rotation stays
 * "link new, retire old", and this is the retire. It rides the same room-less
 * pipe `key link` does, so the connection's authenticated key is the one asking
 * — and the gateway only lets it retire a key of its own identity.
 *
 * Revocation takes effect **immediately**: the retired key's live pipes and
 * terminals are dropped, not merely refused at their next login.
 */
const keyRevoke = async (args: readonly string[]): Promise<number> => {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			args: [...args],
			options: { gateway: { type: "string" } },
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const positionals = parsed.positionals.filter(
		(value): value is string => typeof value === "string"
	);
	const [target] = positionals;
	if (target === undefined || positionals.length > 1) {
		console.error("key revoke takes exactly one key.");
		return 1;
	}
	const gatewayAddress = keyGatewayAddress(parsed.values);
	if (gatewayAddress === "") {
		console.error(
			"key revoke needs a gateway: pass --gateway <addr> or set SUPERVILLAIN_GATEWAY."
		);
		return 1;
	}
	const link = await openKeyConduit(gatewayAddress);
	if (link === undefined) {
		return 1;
	}
	try {
		const outcome = await link.revoke(target);
		if ("rejected" in outcome) {
			console.error(outcome.message);
			return 1;
		}
		console.log(`retired: ${outcome.revoked}`);
		console.log(
			"that key can no longer host, join, or link at this gateway. its lines in\nany room's log stay where they are — this retires the key, not the history."
		);
		// The gateway refuses to retire the key you are asking with, so this list
		// always has at least this machine on it.
		console.log(
			`\nstill yours:\n${outcome.remaining.map((one) => `  ${one}`).join("\n")}`
		);
		return 0;
	} finally {
		await link.close();
	}
};

/**
 * The `key` noun (the #28 pattern). `show` prints the per-machine credential
 * the Host proves itself with; `link` mints a one-time code on an established
 * machine and redeems either code kind on a new one (ADR-0005); `revoke`
 * retires a key from a machine you still control (ADR-0012, NQ-3).
 */
const key = async (args: readonly string[]): Promise<number> => {
	const [subcommand, ...rest] = args;
	if (subcommand === "show" && rest.length === 0) {
		return await keyShow();
	}
	if (subcommand === "link") {
		return await keyLink(rest);
	}
	if (subcommand === "revoke") {
		return await keyRevoke(rest);
	}
	console.error("key requires show, link, or revoke.");
	return 1;
};

/**
 * The `gateway` role selector — deliberately **not** a fourth verb. The pinned
 * verb set (`create` / `join` / `publish`) is the table surface: what a person
 * at a table does. Serving a gateway is an operator act, and ADR-0012 requires
 * it to come out of this same artifact, so it joins `key`/`character`/`map`/
 * `campaign` on the management side of the CLI (ADR-0015).
 */
const gatewayForget = async (args: readonly string[]): Promise<number> => {
	const [address] = args;
	if (address === undefined || args.length !== 1) {
		console.error("gateway forget takes exactly one URL or pairing code.");
		return 1;
	}
	let forgotten: Awaited<ReturnType<typeof forgetGateway>>;
	try {
		forgotten = await forgetGateway(configFolder(), address);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const { host } = new URL(address);
	if (forgotten === undefined) {
		console.error(`nothing pinned for ${host}.`);
		return 1;
	}
	console.log(`forgot:      ${host}`);
	console.log(`fingerprint: sha256:${forgotten.fingerprint}`);
	console.log("pair with that gateway again to trust its current certificate.");
	return 0;
};

const gateway = async (args: readonly string[]): Promise<number> => {
	const [subcommand, ...rest] = args;
	if (subcommand === "--help" || subcommand === "-h") {
		return await runGatewayRole(["--help"]);
	}
	if (subcommand === "forget") {
		return await gatewayForget(rest);
	}
	if (subcommand !== "serve") {
		console.error("gateway requires serve or forget.");
		return 1;
	}
	return await runGatewayRole(rest);
};

const main = async (args: readonly string[]): Promise<number> => {
	// `gateway serve --help` is the gateway role's own help, not the CLI's:
	// its option list is long and lives with the role (ADR-0015).
	if (args[0] === "gateway") {
		return await gateway(args.slice(1));
	}
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
