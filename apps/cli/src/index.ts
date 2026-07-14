#!/usr/bin/env bun
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type {
	GatewayRegistry,
	HostRegistry,
	TableView,
} from "@supervillain/core";
import { decide } from "@supervillain/fake/authority";
import { apply, init } from "@supervillain/fake/model";
import { view } from "@supervillain/fake/view";
import { loadOrCreateIdentity } from "@supervillain/identity";
import { InProcessRoomStore, RoomHost } from "@supervillain/room-host";
import { attachLocalTty } from "@supervillain/session";
import { runTable } from "@supervillain/table";

const USAGE = `Usage:
  supervillain create <campaign-folder> [--game <id>]
  supervillain join
  supervillain publish`;

const hostRegistry: HostRegistry = {
	get: (gameId) =>
		gameId === "fake"
			? ({ authority: { decide }, model: { apply, init } } as never)
			: undefined,
};
const gatewayRegistry: GatewayRegistry = {
	get: (gameId) =>
		gameId === "fake" ? ({ model: { apply, init }, view } as never) : undefined,
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
	// Issue #10 flips the default to draw-steel.
	const gameId =
		typeof parsed.values.game === "string" ? parsed.values.game : "fake";
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
	const table: TableView = { gmSeatId: "gm", seats: [{ actor, id: "gm" }] };
	const host = await RoomHost.open({
		actor,
		campaignFolder,
		gameId,
		registry: hostRegistry,
		table,
	});
	const session = attachLocalTty({ actor });
	await runTable({
		entry,
		gameId,
		roomLabel: path.basename(path.resolve(campaignFolder)),
		session,
		store: new InProcessRoomStore(host),
		table,
	});
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
	if (verb === "join" || verb === "publish") {
		console.error(`${verb} arrives with a later release.`);
		return 1;
	}
	console.error(`Unknown command '${verb}'.`);
	return 1;
};

process.exitCode = await main(process.argv.slice(2));
