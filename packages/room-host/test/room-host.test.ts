/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite; the harness picks bun:test or vitest at runtime. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry, RoomStore, TableView } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import { apply, init } from "../../games/fake/src/model.js";
import { InProcessRoomStore, RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const table: TableView = {
	gmSeatId: "gm",
	seats: [
		{ actor: "actor-gm", id: "gm" },
		{ actor: "actor-guest", id: "guest" },
	],
};

const registry: HostRegistry = {
	get(gameId) {
		return gameId === "fake"
			? { authority: { decide }, model: { apply, init } }
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

describe("RoomHost", () => {
	test("runs decide as the single writer and persists one shared Log", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				clock: clockAt(),
				gameId: "fake",
				registry,
				table,
			});
			const accepted = await host.submit({
				actor: "actor-guest",
				command: { seatId: "guest", type: "fake.visit" },
			});

			expect(accepted).toMatchObject({ accepted: true });
			expect(host.snapshot()).toEqual({
				game: { lastSeatId: "guest", visits: 1 },
				gameId: "fake",
				seq: 3,
				table,
			});
			const bytes = await readFile(
				path.join(campaignFolder, "events.jsonl"),
				"utf-8"
			);
			const lines = bytes
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines.map(({ type }) => type)).toEqual([
				"core.room-created",
				"fake.seat-observed",
				"fake.visit-counted",
			]);
			expect(lines[1]).toEqual({
				actor: "actor-guest",
				payload: { seatId: "guest" },
				seq: 2,
				timestamp: timestamps[1],
				type: "fake.seat-observed",
			});
		});
	});

	test("returns Rejections to the caller and appends nothing", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				clock: clockAt(),
				gameId: "fake",
				registry,
				table,
			});
			const before = await readFile(path.join(campaignFolder, "events.jsonl"));
			const result = await host.submit({
				actor: "actor-guest",
				command: { reason: "not now", type: "fake.reject" },
			});

			expect(result).toEqual({ message: "not now", rejected: true });
			expect(await readFile(path.join(campaignFolder, "events.jsonl"))).toEqual(
				before
			);
			expect(host.snapshot().seq).toBe(1);
		});
	});

	test("Replay preserves bytes and state, then continues the sequence", async () => {
		await withCampaign(async (campaignFolder) => {
			const first = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				clock: clockAt(),
				gameId: "fake",
				registry,
				table,
			});
			await first.submit({
				actor: "actor-guest",
				command: { seatId: "guest", type: "fake.visit" },
			});
			const bytes = await readFile(path.join(campaignFolder, "events.jsonl"));
			const expected = first.snapshot();

			const restarted = await RoomHost.open({
				campaignFolder,
				clock: clockAt(3),
				registry,
				table,
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
				envelopes: [{ seq: 4 }, { seq: 5 }],
			});
		});
	});

	test("fails loudly when Replay cannot resolve the logged game id", async () => {
		await withCampaign(async (campaignFolder) => {
			await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				gameId: "fake",
				registry,
				table,
			});
			await expect(
				RoomHost.open({
					campaignFolder,
					registry: { get: () => {} },
					table,
				})
			).rejects.toThrow("No game authority is registered for 'fake'.");
		});
	});

	test("the in-process RoomStore catches up and follows from a sequence", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				clock: clockAt(),
				gameId: "fake",
				registry,
				table,
			});
			const store: RoomStore = new InProcessRoomStore(host);
			const iterator = store.stream(1)[Symbol.asyncIterator]();
			const first = await iterator.next();
			expect(first.value).toMatchObject({
				seq: 1,
				type: "core.room-created",
			});

			await store.submit({
				actor: "actor-guest",
				command: { seatId: "guest", type: "fake.visit" },
			});
			const second = await iterator.next();
			expect(second.value).toMatchObject({
				seq: 2,
				type: "fake.seat-observed",
			});
			const third = await iterator.next();
			expect(third.value).toMatchObject({
				seq: 3,
				type: "fake.visit-counted",
			});
			await iterator.return?.();
		});
	});
});
