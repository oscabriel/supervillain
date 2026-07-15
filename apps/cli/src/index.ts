#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type {
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
import { connectRoomStore, serveRoomStore } from "@supervillain/room-wire";
import { attachLocalTty } from "@supervillain/session";
import { runTable } from "@supervillain/table";
import { openIrohEndpoint } from "@supervillain/transport-iroh";
import type { TransportAddress } from "@supervillain/transport-iroh";

const USAGE = `Usage:
  supervillain create <campaign-folder> [--game <id>]
  supervillain join <room-ref>
  supervillain publish`;

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
}

const contentRegistry = new Map<string, RegisteredContent>([
	["fake", fakeContent],
	["draw-steel", { ...drawSteelContent, intake: drawSteelIntake }],
]);

const isNodeError = (
	error: unknown
): error is Error & { readonly code: string } =>
	error instanceof Error && "code" in error && typeof error.code === "string";

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
				help: { short: "h", type: "boolean" },
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
	const endpoint = await openIrohEndpoint({
		secretKeyHex: identity.secretKeyHex,
	});
	const server = serveRoomStore(endpoint, store, {
		info: { gameId, label: roomLabel },
	});
	await writeFile(
		path.join(campaignFolder, "door.txt"),
		`${endpoint.address}\n`
	);
	process.stdout.write(
		`your table is live. summon your players:\n\n  supervillain join ${endpoint.address}\n\n`
	);
	await runIntake(campaignFolder, gameId, actor, store);
	const session = attachLocalTty({ actor });
	await runTable({ entry, gameId, roomLabel, session, store });
	await server.close();
	await endpoint.close();
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
	const endpoint = await openIrohEndpoint({
		secretKeyHex: identity.secretKeyHex,
	});
	let store: Awaited<ReturnType<typeof connectRoomStore>>;
	try {
		store = await connectRoomStore(endpoint, roomRef as TransportAddress);
	} catch {
		console.error("Could not reach that room. Is the GM's table live?");
		await endpoint.close();
		return 1;
	}
	const info = await store.info();
	const entry = gatewayRegistry.get(info.gameId);
	if (entry === undefined) {
		console.error(`Unknown game '${info.gameId}'.`);
		await store.close();
		await endpoint.close();
		return 1;
	}
	const claim = await store.submit({
		actor,
		command: { type: "core.claim-seat" },
	});
	if ("rejected" in claim) {
		console.error(claim.message);
		await store.close();
		await endpoint.close();
		return 1;
	}
	await runTable({
		entry,
		gameId: info.gameId,
		roomLabel: info.label,
		session: attachLocalTty({ actor }),
		store,
	});
	await store.close();
	await endpoint.close();
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
	if (verb === "create") {
		return await create(rest);
	}
	if (verb === "join") {
		return await join(rest);
	}
	if (verb === "publish") {
		console.error("publish arrives with a later release.");
		return 1;
	}
	console.error(`Unknown command '${verb}'.`);
	return 1;
};

process.exitCode = await main(process.argv.slice(2));
