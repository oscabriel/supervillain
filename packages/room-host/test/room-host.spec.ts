import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostRegistry, RoomStore, TableView } from "@supervillain/core";
import { decide } from "../../games/fake/src/authority.js";
import { apply, init } from "../../games/fake/src/model.js";
import { InProcessRoomStore, RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const table: TableView = {
  gmSeatId: "gm",
  seats: [
    { id: "gm", actor: "actor-gm" },
    { id: "guest", actor: "actor-guest" },
  ],
};

const registry: HostRegistry = {
  get(gameId) {
    return gameId === "fake" ? { model: { init, apply }, authority: { decide } } : undefined;
  },
};

const timestamps = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:01.000Z",
  "2026-01-01T00:00:02.000Z",
  "2026-01-01T00:00:03.000Z",
];

async function withCampaign(run: (folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "supervillain-room-host-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function clockAt(start = 0): () => string {
  let index = start;
  return () => timestamps[index++] ?? "2026-01-01T00:00:59.000Z";
}

describe("RoomHost", () => {
  test("runs decide as the single writer and persists one shared Log", async () => {
    await withCampaign(async (campaignFolder) => {
      const host = await RoomHost.open({
        campaignFolder,
        registry,
        table,
        gameId: "fake",
        actor: "actor-gm",
        clock: clockAt(),
      });
      const accepted = await host.submit({
        actor: "actor-guest",
        command: { type: "fake.visit", seatId: "guest" },
      });

      expect(accepted).toMatchObject({ accepted: true });
      expect(host.snapshot()).toEqual({
        gameId: "fake",
        game: { visits: 1, lastSeatId: "guest" },
        table,
        seq: 3,
      });
      const lines = (await readFile(join(campaignFolder, "events.jsonl"), "utf8"))
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
        seq: 2,
        timestamp: timestamps[1],
        type: "fake.seat-observed",
        payload: { seatId: "guest" },
      });
    });
  });

  test("returns Rejections to the caller and appends nothing", async () => {
    await withCampaign(async (campaignFolder) => {
      const host = await RoomHost.open({
        campaignFolder,
        registry,
        table,
        gameId: "fake",
        actor: "actor-gm",
        clock: clockAt(),
      });
      const before = await readFile(join(campaignFolder, "events.jsonl"));
      const result = await host.submit({
        actor: "actor-guest",
        command: { type: "fake.reject", reason: "not now" },
      });

      expect(result).toEqual({ rejected: true, message: "not now" });
      expect(await readFile(join(campaignFolder, "events.jsonl"))).toEqual(before);
      expect(host.snapshot().seq).toBe(1);
    });
  });

  test("Replay preserves bytes and state, then continues the sequence", async () => {
    await withCampaign(async (campaignFolder) => {
      const first = await RoomHost.open({
        campaignFolder,
        registry,
        table,
        gameId: "fake",
        actor: "actor-gm",
        clock: clockAt(),
      });
      await first.submit({
        actor: "actor-guest",
        command: { type: "fake.visit", seatId: "guest" },
      });
      const bytes = await readFile(join(campaignFolder, "events.jsonl"));
      const expected = first.snapshot();

      const restarted = await RoomHost.open({
        campaignFolder,
        registry,
        table,
        clock: clockAt(3),
      });
      expect(await readFile(join(campaignFolder, "events.jsonl"))).toEqual(bytes);
      expect(restarted.snapshot()).toEqual(expected);

      const result = await restarted.submit({
        actor: "actor-gm",
        command: { type: "fake.visit", seatId: "gm" },
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
        campaignFolder,
        registry,
        table,
        gameId: "fake",
        actor: "actor-gm",
      });
      await expect(
        RoomHost.open({ campaignFolder, registry: { get: () => undefined }, table }),
      ).rejects.toThrow("No game authority is registered for 'fake'.");
    });
  });

  test("the in-process RoomStore catches up and follows from a sequence", async () => {
    await withCampaign(async (campaignFolder) => {
      const host = await RoomHost.open({
        campaignFolder,
        registry,
        table,
        gameId: "fake",
        actor: "actor-gm",
        clock: clockAt(),
      });
      const store: RoomStore = new InProcessRoomStore(host);
      const iterator = store.stream(1)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ seq: 1, type: "core.room-created" });

      await store.submit({
        actor: "actor-guest",
        command: { type: "fake.visit", seatId: "guest" },
      });
      expect((await iterator.next()).value).toMatchObject({ seq: 2, type: "fake.seat-observed" });
      expect((await iterator.next()).value).toMatchObject({ seq: 3, type: "fake.visit-counted" });
      await iterator.return?.();
    });
  });
});
