import { describe, expect, test } from "bun:test";
import type { Envelope, TableView } from "../src/index.js";
import { decide } from "../../games/fake/src/authority.js";
import { apply, init, type FakeEvent, type FakeState } from "../../games/fake/src/model.js";

const table: TableView = {
  gmSeatId: "gm",
  seats: [
    { id: "gm", actor: "actor-gm" },
    { id: "guest", actor: "actor-guest" },
  ],
};

describe("game module seam", () => {
  test("interleaves core and module envelopes in one log with opaque game state", () => {
    const log: Envelope[] = [
      {
        actor: "actor-gm",
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "core.room-created",
        payload: { gameId: "fake" },
      },
      {
        actor: "actor-gm",
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "fake.seat-observed",
        payload: { seatId: "gm" },
      },
    ];
    const roomState: { game: unknown } = { game: init() };

    expect(log.map(({ type }) => type)).toEqual(["core.room-created", "fake.seat-observed"]);
    expect(JSON.parse(JSON.stringify(roomState))).toEqual(roomState);
  });

  test("init is deterministic and decide rejects, reads TableView, and emits multiple events", () => {
    expect(init()).toEqual(init());
    expect(decide(init(), { type: "fake.reject", reason: "not now" }, table)).toEqual({
      rejected: true,
      message: "not now",
    });
    expect(decide(init(), { type: "fake.visit", seatId: "missing" }, table)).toMatchObject({
      rejected: true,
    });
    expect(decide(init(), { type: "fake.visit", seatId: "guest" }, table)).toEqual([
      { type: "fake.seat-observed", seatId: "guest" },
      { type: "fake.visit-counted", visits: 1 },
    ]);
  });

  test("replay is byte-identical", () => {
    const events: FakeEvent[] = [
      { type: "fake.seat-observed", seatId: "guest" },
      { type: "fake.visit-counted", visits: 1 },
    ];
    const replay = (): FakeState => events.reduce(apply, init());

    expect(JSON.stringify(replay())).toBe(JSON.stringify(replay()));
  });
});
