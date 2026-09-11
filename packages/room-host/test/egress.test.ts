/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite. */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LOG_EGRESS_REFUSAL, markTrustedRoomCommand } from "@supervillain/core";
import type { HostRegistry } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import { apply, eventTypes, init } from "../../games/fake/src/model.js";
import { openLocalLogSource, pullLog, RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const registry: HostRegistry = {
	get(gameId) {
		return gameId === "fake"
			? {
					authority: { decide },
					grammar: { eventTypes },
					model: { apply, init },
				}
			: undefined;
	},
};

const GM = "a".repeat(64);
const GM_LAPTOP = "b".repeat(64);
const PLAYER = "c".repeat(64);
const STRANGER = "d".repeat(64);

let tick = 0;
const clock = (): string => {
	tick += 1;
	return `2026-01-01T00:00:${String(tick).padStart(2, "0")}.000Z`;
};

const withScratch = async (
	run: (scratch: string) => Promise<void>
): Promise<void> => {
	const scratch = await mkdtemp(path.join(tmpdir(), "supervillain-egress-"));
	try {
		await run(scratch);
	} finally {
		await rm(scratch, { force: true, recursive: true });
	}
};

/** A room with a GM, a seated player, a linked GM laptop, a chat line from
 * someone who never sat down, and game state — the shapes pull must carry. */
const playedRoom = async (folder: string): Promise<RoomHost> => {
	const host = await RoomHost.open({
		actor: GM,
		campaignFolder: folder,
		clock,
		gameId: "fake",
		registry,
	});
	await host.submit({ actor: PLAYER, command: { type: "core.claim-seat" } });
	await host.submit({
		actor: PLAYER,
		command: { seatId: "player-1", type: "fake.visit" },
	});
	await host.submit({
		actor: GM,
		command: { text: "welcome", type: "core.chat" },
	});
	await host.submit(
		markTrustedRoomCommand({
			actor: GM,
			command: { linked: GM_LAPTOP, type: "core.link-actor" },
		})
	);
	return host;
};

const exists = async (file: string): Promise<boolean> => {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
};

describe("log egress", () => {
	test("pulls a byte-identical log into a fresh folder that replays to the same state", async () => {
		await withScratch(async (scratch) => {
			const sourceFolder = path.join(scratch, "source");
			const host = await playedRoom(sourceFolder);
			// Sidecars beside the source log must not travel: pull is the log.
			await mkdir(path.join(sourceFolder, "characters"));
			await writeFile(path.join(sourceFolder, "characters", "x.json"), "{}");

			const destination = path.join(scratch, "pulled", "nested");
			const source = await openLocalLogSource(sourceFolder);
			const outcome = await pullLog({ actor: GM, destination, source });
			expect(outcome).toEqual({
				eventCount: 7,
				logPath: path.join(destination, "events.jsonl"),
			});

			const sourceBytes = await readFile(
				path.join(sourceFolder, "events.jsonl")
			);
			const pulledBytes = await readFile(
				path.join(destination, "events.jsonl")
			);
			expect(Buffer.from(pulledBytes).equals(sourceBytes)).toBe(true);
			expect(await readdir(destination)).toEqual(["events.jsonl"]);

			// The pulled folder is an ordinary Campaign folder: it opens under a
			// local Host with no gameId or actor, and folds to the source's state.
			const resumed = await RoomHost.open({
				campaignFolder: destination,
				registry,
			});
			expect(resumed.snapshot()).toEqual(host.snapshot());
			expect(resumed.actors()).toEqual(host.actors());
			// And pull wrote nothing back: the source is untouched.
			const sourceAfter = await readFile(
				path.join(sourceFolder, "events.jsonl")
			);
			expect(Buffer.from(sourceAfter).equals(sourceBytes)).toBe(true);
			const sourceEntries = await readdir(sourceFolder);
			expect(sourceEntries.toSorted()).toEqual(["characters", "events.jsonl"]);
		});
	});

	test("any identity that holds or held a seat can pull, through the link graph", async () => {
		await withScratch(async (scratch) => {
			const sourceFolder = path.join(scratch, "source");
			await playedRoom(sourceFolder);
			const source = await openLocalLogSource(sourceFolder);
			for (const [name, actor] of [
				["player", PLAYER],
				["laptop", GM_LAPTOP],
			] as const) {
				const destination = path.join(scratch, name);
				// oxlint-disable-next-line eslint/no-await-in-loop -- each pull is a separate folder; ordering keeps failures attributable.
				const outcome = await pullLog({ actor, destination, source });
				expect(outcome).toMatchObject({ eventCount: 7 });
			}
		});
	});

	test("a seat that only history records still authorizes", async () => {
		await withScratch(async (scratch) => {
			const sourceFolder = path.join(scratch, "source");
			await mkdir(sourceFolder);
			// A hand-written log: the player sat down long ago and the room moved
			// on; nothing since names them. Seat-holding is in the log, so it
			// still counts.
			const lines = [
				{ actor: GM, payload: { gameId: "fake" }, type: "core.room-created" },
				{ actor: GM, payload: { seatId: "gm" }, type: "core.seat-claimed" },
				{
					actor: PLAYER,
					payload: { seatId: "player-1" },
					type: "core.seat-claimed",
				},
				{
					actor: GM,
					payload: { text: "years later" },
					type: "core.chat-posted",
				},
			].map((line, index) => ({ ...line, seq: index + 1, timestamp: clock() }));
			await writeFile(
				path.join(sourceFolder, "events.jsonl"),
				`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
			);
			const source = await openLocalLogSource(sourceFolder);
			const destination = path.join(scratch, "pulled");
			expect(
				await pullLog({ actor: PLAYER, destination, source })
			).toMatchObject({
				eventCount: 4,
			});
		});
	});

	test("refuses an identity the log never seated, and writes nothing", async () => {
		await withScratch(async (scratch) => {
			const sourceFolder = path.join(scratch, "source");
			const host = await playedRoom(sourceFolder);
			// A line in the log is not a seat: a chat from a seatless actor would
			// be refused by the Host, but even an actor the log mentions without a
			// seat claim gets nothing here. Spectators never wrote a line at all.
			await host.submit({
				actor: STRANGER,
				command: { text: "hi", type: "core.chat" },
			});
			const source = await openLocalLogSource(sourceFolder);
			const destination = path.join(scratch, "pulled");
			expect(await pullLog({ actor: STRANGER, destination, source })).toEqual({
				message: LOG_EGRESS_REFUSAL,
				rejected: true,
			});
			expect(await exists(destination)).toBe(false);
		});
	});

	test("refuses a destination that is not fresh, before writing", async () => {
		await withScratch(async (scratch) => {
			const sourceFolder = path.join(scratch, "source");
			await playedRoom(sourceFolder);
			const source = await openLocalLogSource(sourceFolder);

			const occupied = path.join(scratch, "occupied");
			await mkdir(occupied);
			await writeFile(path.join(occupied, "notes.txt"), "mine");
			await expect(
				pullLog({ actor: GM, destination: occupied, source })
			).rejects.toThrow(/is not empty/u);
			expect(await readdir(occupied)).toEqual(["notes.txt"]);

			// Pulling a room onto itself is the same refusal: never a merge.
			await expect(
				pullLog({ actor: GM, destination: sourceFolder, source })
			).rejects.toThrow(/is not empty/u);

			const file = path.join(scratch, "a-file");
			await writeFile(file, "");
			await expect(
				pullLog({ actor: GM, destination: file, source })
			).rejects.toThrow(/is not a folder/u);

			// An empty folder is fresh.
			const empty = path.join(scratch, "empty");
			await mkdir(empty);
			expect(
				await pullLog({ actor: GM, destination: empty, source })
			).toMatchObject({
				eventCount: 7,
			});
		});
	});

	test("names a missing or malformed source plainly", async () => {
		await withScratch(async (scratch) => {
			const missing = path.join(scratch, "nowhere");
			await expect(openLocalLogSource(missing)).rejects.toThrow(
				`No room log at ${path.join(missing, "events.jsonl")}.`
			);

			const garbage = path.join(scratch, "garbage");
			await mkdir(garbage);
			await writeFile(path.join(garbage, "events.jsonl"), "not json\n");
			await expect(openLocalLogSource(garbage)).rejects.toThrow(
				/is not a room log/u
			);

			const noRoom = path.join(scratch, "no-room");
			await mkdir(noRoom);
			await writeFile(
				path.join(noRoom, "events.jsonl"),
				`${JSON.stringify({ actor: GM, seq: 1, type: "core.chat-posted" })}\n`
			);
			await expect(openLocalLogSource(noRoom)).rejects.toThrow(
				/is not a room log/u
			);
		});
	});
});
