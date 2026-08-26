/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite runs under bun:test and vitest alike. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import type { FakeState } from "../../games/fake/src/model.js";
import { apply, eventTypes, init } from "../../games/fake/src/model.js";
import { RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

/** A healthy registry for reopening: proves the log itself stays openable
 * whatever the first host did. */
const cleanRegistry: HostRegistry = {
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

/**
 * A module whose apply refuses one visit-counted event, exactly once — the
 * shape of a transient or one-shot fold bug. Afterwards it delegates to the
 * real fold for good, because the resync recovery refolds the stranded line
 * through this very `apply`: poison that never yields would keep the host
 * failing loudly on every future fold (and every future replay), which is
 * the halt posture of ADR-0010 rather than a case memory can heal.
 */
const hostileRegistry = (): HostRegistry => {
	let tripped = false;
	const hostileApply = (
		state: Readonly<FakeState>,
		event: Parameters<typeof apply>[1]
	): FakeState => {
		if (!tripped && event.type === "fake.visit-counted") {
			tripped = true;
			throw new Error("hostile apply");
		}
		return apply(state, event);
	};
	return {
		get(gameId) {
			return gameId === "fake"
				? {
						authority: { decide },
						grammar: { eventTypes },
						model: { apply: hostileApply, init },
					}
				: undefined;
		},
	};
};

/** Reads back every envelope line with its position, so contiguity of `seq`
 * is asserted straight off the bytes on disk. */
const readLog = async (
	campaignFolder: string
): Promise<{ readonly seq: number; readonly type: string }[]> =>
	(await readFile(path.join(campaignFolder, "events.jsonl"), "utf-8"))
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));

const withCampaign = async (
	run: (folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-fold-failure-"));
	try {
		await run(folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

describe("RoomHost fold failure safety", () => {
	test("a fold that throws after the write resynchronizes memory from the log", async () => {
		await withCampaign(async (campaignFolder) => {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder,
				gameId: "fake",
				registry: hostileRegistry(),
			});
			await host.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			expect(await readLog(campaignFolder)).toHaveLength(3);

			// `fake.visit` decides two events; the second one trips. The whole
			// batch is already fsynced when the fold throws, so the error
			// surfaces — and nothing else about the host breaks.
			await expect(
				host.submit({
					actor: "actor-guest",
					command: { seatId: "player-1", type: "fake.visit" },
				})
			).rejects.toThrow("hostile apply");

			// The stranded lines sit at 4 and 5; the file keeps strictly
			// sequential sequence numbers.
			expect(await readLog(campaignFolder)).toEqual([
				expect.objectContaining({ seq: 1, type: "core.room-created" }),
				expect.objectContaining({ seq: 2, type: "core.seat-claimed" }),
				expect.objectContaining({ seq: 3, type: "core.seat-claimed" }),
				expect.objectContaining({ seq: 4, type: "fake.seat-observed" }),
				expect.objectContaining({ seq: 5, type: "fake.visit-counted" }),
			]);

			// Memory equals a fresh replay of the same bytes: the resync
			// refolded everything, the stranded visit included.
			const reopened = await RoomHost.open({
				campaignFolder,
				registry: cleanRegistry,
			});
			expect(reopened.snapshot()).toEqual(host.snapshot());
			expect(reopened.snapshot().game).toEqual({
				lastCharacterId: null,
				lastSeatId: "player-1",
				visits: 1,
			});

			// THE regression: the next accepted submission mints seq
			// file-lines + 1, not a collision with the stranded tail.
			const next = await host.submit({
				actor: "actor-gm",
				command: { text: "still here", type: "core.chat" },
			});
			expect(next).toMatchObject({
				accepted: true,
				envelopes: [{ seq: 6 }],
			});
			expect(await readLog(campaignFolder)).toHaveLength(6);

			// …and a restart after that continuation still opens green.
			const again = await RoomHost.open({
				campaignFolder,
				registry: cleanRegistry,
			});
			expect(again.snapshot()).toEqual(host.snapshot());
		});
	});
});
