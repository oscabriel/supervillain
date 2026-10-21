import { describe, expect, test } from "bun:test";
import { fold } from "../src/index.ts";
import { env, tally } from "./tally.ts";

describe("fold", () => {
  test("applies every event in order", () => {
    const result = fold(tally, [env(1, "added", { n: 2 }), env(2, "rolled", { value: 5 })], {
      strict: true,
    });
    expect(result.state).toEqual({ total: 7, rolls: [5] });
    expect(result.skipped).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("strict: halts at an unknown event type, keeping the state before it", () => {
    const result = fold(
      tally,
      [env(1, "added", { n: 2 }), env(2, "teleported", {}), env(3, "added", { n: 1 })],
      { strict: true },
    );
    expect(result.state).toEqual({ total: 2, rolls: [] });
    expect(result.error).toEqual({ seq: 2, message: 'unknown event type "teleported"' });
  });

  test("lenient: skips unknown event types and lists them, then carries on", () => {
    const teleported = env(2, "teleported", {});
    const result = fold(tally, [env(1, "added", { n: 2 }), teleported, env(3, "added", { n: 1 })], {
      strict: false,
    });
    expect(result.state).toEqual({ total: 3, rolls: [] });
    expect(result.skipped).toEqual([teleported]);
    expect(result.error).toBeUndefined();
  });

  test("stops where apply throws, strict or not", () => {
    const events = [env(1, "added", { n: 2 }), env(2, "poisoned", {}), env(3, "added", { n: 1 })];
    for (const strict of [true, false]) {
      const result = fold(tally, events, { strict });
      expect(result.state).toEqual({ total: 2, rolls: [] });
      expect(result.error).toEqual({ seq: 2, message: "apply blew up" });
    }
  });
});
