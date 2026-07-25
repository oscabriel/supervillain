/* oxlint-disable vitest/prefer-importing-vitest-globals, unicorn/no-await-expression-member -- dual-lane suite uses direct assertions on ordered async iterator and file results. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry, RoomStore } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import { apply, eventTypes, init } from "../../games/fake/src/model.js";
import { InProcessRoomStore, RoomHost } from "../src/index.js";
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

const timestamps = [
	"2026-01-01T00:00:00.000Z",
	"2026-01-01T00:00:01.000Z",
	"2026-01-01T00:00:02.000Z",
	"2026-01-01T00:00:03.000Z",
];

const withCampaign = async (
	run: (folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-room-host-"));
	try {
		await run(folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

const clockAt = (start = 0): (() => string) => {
	let index = start;
	return () => {
		const value = timestamps[index];
		index += 1;
		return value ?? "2026-01-01T00:00:59.000Z";
	};
};

/** Writes a campaign log that opens with the two envelopes every room starts
 * with, then the given ones — sequence numbers are the JSONL line numbers. */
const writeLog = async (
	campaignFolder: string,
	tail: readonly {
		readonly actor: string;
		readonly payload: unknown;
		readonly type: string;
	}[]
): Promise<void> => {
	const envelopes = [
		{
			actor: "actor-gm",
			payload: { gameId: "fake" },
			type: "core.room-created",
		},
		{ actor: "actor-gm", payload: { seatId: "gm" }, type: "core.seat-claimed" },
		...tail,
	].map((envelope, index) => ({
		...envelope,
		seq: index + 1,
		timestamp: timestamps[index] ?? "2026-01-01T00:00:59.000Z",
	}));
	await writeFile(
		path.join(campaignFolder, "events.jsonl"),
		`${envelopes.map((value) => JSON.stringify(value)).join("\n")}\n`
	);
};

const openHost = (campaignFolder: string, start = 0): Promise<RoomHost> =>
	RoomHost.open({
		actor: "actor-gm",
		campaignFolder,
		clock: clockAt(start),
		gameId: "fake",
		registry,
	});

describe("RoomHost", () => {
	test("creates a room and its GM seat as the first two Log envelopes", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await openHost(campaignFolder);
			const lines = (
				await readFile(path.join(campaignFolder, "events.jsonl"), "utf-8")
			)
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines).toEqual([
				{
					actor: "actor-gm",
					payload: { gameId: "fake" },
					seq: 1,
					timestamp: timestamps[0],
					type: "core.room-created",
				},
				{
					actor: "actor-gm",
					payload: { seatId: "gm" },
					seq: 2,
					timestamp: timestamps[1],
					type: "core.seat-claimed",
				},
			]);
			expect(host.snapshot().table).toEqual({
				actor: "",
				gmSeatId: "gm",
				seats: [{ actor: "actor-gm", characterId: null, id: "gm" }],
			});
		});
	});

	test("runs decide with the current log-derived TableView", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await openHost(campaignFolder);
			await host.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			const accepted = await host.submit({
				actor: "actor-guest",
				command: { seatId: "player-1", type: "fake.visit" },
			});
			expect(accepted).toMatchObject({ accepted: true });
			expect(host.snapshot()).toEqual({
				game: {
					lastCharacterId: null,
					lastSeatId: "player-1",
					visits: 1,
				},
				gameId: "fake",
				seq: 5,
				table: {
					actor: "",
					gmSeatId: "gm",
					seats: [
						{ actor: "actor-gm", characterId: null, id: "gm" },
						{
							actor: "actor-guest",
							characterId: null,
							id: "player-1",
						},
					],
				},
			});
		});
	});

	test("returns Rejections to the caller and appends nothing", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await openHost(campaignFolder);
			const before = await readFile(path.join(campaignFolder, "events.jsonl"));
			const result = await host.submit({
				actor: "actor-guest",
				command: { reason: "not now", type: "fake.reject" },
			});
			expect(result).toEqual({ message: "not now", rejected: true });
			expect(await readFile(path.join(campaignFolder, "events.jsonl"))).toEqual(
				before
			);
			expect(host.snapshot().seq).toBe(2);
		});
	});

	test("Replay derives seats and game state, then continues the sequence", async () => {
		await withCampaign(async (campaignFolder) => {
			const first = await openHost(campaignFolder);
			await first.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			await first.submit({
				actor: "actor-guest",
				command: { seatId: "player-1", type: "fake.visit" },
			});
			const bytes = await readFile(path.join(campaignFolder, "events.jsonl"));
			const expected = first.snapshot();

			const restarted = await RoomHost.open({
				campaignFolder,
				clock: clockAt(3),
				registry,
			});
			expect(await readFile(path.join(campaignFolder, "events.jsonl"))).toEqual(
				bytes
			);
			expect(restarted.snapshot()).toEqual(expected);
			const result = await restarted.submit({
				actor: "actor-gm",
				command: { seatId: "gm", type: "fake.visit" },
			});
			expect(result).toMatchObject({
				accepted: true,
				envelopes: [{ seq: 6 }, { seq: 7 }],
			});
		});
	});

	test("replays v0-shaped logs byte-identically with null bindings", async () => {
		await withCampaign(async (campaignFolder) => {
			const envelopes = [
				{
					actor: "actor-gm",
					payload: { gameId: "fake" },
					seq: 1,
					timestamp: timestamps[0],
					type: "core.room-created",
				},
				{
					actor: "actor-gm",
					payload: { seatId: "gm" },
					seq: 2,
					timestamp: timestamps[1],
					type: "core.seat-claimed",
				},
				{
					actor: "actor-gm",
					payload: { text: "hello" },
					seq: 3,
					timestamp: timestamps[2],
					type: "core.chat-posted",
				},
				{
					actor: "actor-gm",
					payload: { modifier: 0, notation: "d6", rolls: [4], total: 4 },
					seq: 4,
					timestamp: timestamps[3],
					type: "core.dice-rolled",
				},
				{
					actor: "actor-gm",
					payload: { seatId: "gm" },
					seq: 5,
					timestamp: "2026-01-01T00:00:04.000Z",
					type: "fake.seat-observed",
				},
				{
					actor: "actor-gm",
					payload: { visits: 1 },
					seq: 6,
					timestamp: "2026-01-01T00:00:05.000Z",
					type: "fake.visit-counted",
				},
			];
			const bytes = `${envelopes.map((value) => JSON.stringify(value)).join("\n")}\n`;
			const logPath = path.join(campaignFolder, "events.jsonl");
			await writeFile(logPath, bytes);

			const host = await RoomHost.open({ campaignFolder, registry });
			expect(await readFile(logPath, "utf-8")).toBe(bytes);
			expect(host.snapshot()).toEqual({
				game: { lastCharacterId: null, lastSeatId: "gm", visits: 1 },
				gameId: "fake",
				seq: 6,
				table: {
					actor: "",
					gmSeatId: "gm",
					seats: [{ actor: "actor-gm", characterId: null, id: "gm" }],
				},
			});
		});
	});

	test("rejects a log binding an unknown seat", async () => {
		await withCampaign(async (campaignFolder) => {
			const envelopes = [
				{
					actor: "actor-gm",
					payload: { gameId: "fake" },
					seq: 1,
					timestamp: timestamps[0],
					type: "core.room-created",
				},
				{
					actor: "actor-gm",
					payload: { seatId: "gm" },
					seq: 2,
					timestamp: timestamps[1],
					type: "core.seat-claimed",
				},
				{
					actor: "actor-gm",
					payload: { characterId: "hero", seatId: "missing" },
					seq: 3,
					timestamp: timestamps[2],
					type: "core.character-bound",
				},
			];
			await writeFile(
				path.join(campaignFolder, "events.jsonl"),
				`${envelopes.map((value) => JSON.stringify(value)).join("\n")}\n`
			);

			await expect(RoomHost.open({ campaignFolder, registry })).rejects.toThrow(
				"Log binds a character to unknown seat 'missing' at line 3."
			);
		});
	});

	test("refuses to open a log carrying an unknown core event type", async () => {
		await withCampaign(async (campaignFolder) => {
			await writeLog(campaignFolder, [
				{
					actor: "actor-gm",
					payload: { name: "the keep" },
					type: "core.map-loaded",
				},
			]);

			await expect(RoomHost.open({ campaignFolder, registry })).rejects.toThrow(
				"Log contains unknown event type 'core.map-loaded' at line 3 — this host is too old."
			);
		});
	});

	test("refuses to open a log carrying a game event outside the grammar", async () => {
		await withCampaign(async (campaignFolder) => {
			await writeLog(campaignFolder, [
				{ actor: "actor-gm", payload: { size: 3 }, type: "fake.party-grown" },
			]);

			await expect(RoomHost.open({ campaignFolder, registry })).rejects.toThrow(
				"Log contains unknown event type 'fake.party-grown' at line 3 — this host is too old."
			);
		});
	});

	test("refuses to open a log whose game event carries no object payload", async () => {
		await withCampaign(async (campaignFolder) => {
			await writeLog(campaignFolder, [
				{
					actor: "actor-gm",
					payload: "not-an-object",
					type: "fake.visit-counted",
				},
			]);

			await expect(RoomHost.open({ campaignFolder, registry })).rejects.toThrow(
				"Event 'fake.visit-counted' at line 3 must carry an object payload."
			);
		});
	});

	test("refuses to write a game event outside the module's declared grammar", async () => {
		await withCampaign(async (campaignFolder) => {
			const rogue: HostRegistry = {
				get: () => ({
					authority: { decide: () => [{ type: "fake.undeclared" }] },
					grammar: { eventTypes },
					model: { apply, init },
				}),
			};
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				gameId: "fake",
				registry: rogue,
			});

			await expect(
				host.submit({ actor: "actor-gm", command: { type: "fake.visit" } })
			).rejects.toThrow(
				"Game 'fake' emitted event 'fake.undeclared', which is outside its declared event grammar."
			);
		});
	});

	test("replays a shipped legacy game event shape green", async () => {
		await withCampaign(async (campaignFolder) => {
			// The pre-`characterId` `fake.seat-observed` a released host once
			// wrote: recognized and valid forever, upgraded on read (ADR-0010).
			await writeLog(campaignFolder, [
				{
					actor: "actor-gm",
					payload: { seatId: "gm" },
					type: "fake.seat-observed",
				},
				{
					actor: "actor-gm",
					payload: { characterId: "hero", seatId: "gm" },
					type: "fake.seat-observed",
				},
			]);

			const host = await RoomHost.open({ campaignFolder, registry });
			expect(host.snapshot().game).toEqual({
				lastCharacterId: "hero",
				lastSeatId: "gm",
				visits: 0,
			});
		});
	});

	test("the in-process RoomStore catches up and follows from a sequence", async () => {
		await withCampaign(async (campaignFolder) => {
			const store: RoomStore = new InProcessRoomStore(
				await openHost(campaignFolder)
			);
			const iterator = store.stream(1)[Symbol.asyncIterator]();
			expect((await iterator.next()).value).toMatchObject({
				seq: 1,
				type: "core.room-created",
			});
			expect((await iterator.next()).value).toMatchObject({
				seq: 2,
				type: "core.seat-claimed",
			});
			await store.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			expect((await iterator.next()).value).toMatchObject({
				seq: 3,
				type: "core.seat-claimed",
			});
			await iterator.return?.();
		});
	});
});
