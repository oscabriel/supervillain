import { describe, expect, test } from "bun:test";
import { kept } from "../../src/table/keep.ts";

describe("kept", () => {
  const map = (x: number) => ({
    name: "Ford",
    terrain: ["..", ".#"],
    tokens: [
      { id: "vex", x, y: 0 },
      { id: "kor", x: 1, y: 1 },
    ],
  });

  test("a value that reads the same is last time's, so nothing is drawn again", () => {
    const first = map(0);
    expect(kept(first, map(0))).toBe(first);
    expect(kept(undefined, first)).toBe(first);
  });

  test("a changed value keeps every part of it that didn't change", () => {
    const first = map(0);
    const moved = kept(first, map(1));
    expect(moved).toEqual(map(1));
    expect(moved).not.toBe(first);
    expect(moved.terrain).toBe(first.terrain);
    expect(moved.tokens).not.toBe(first.tokens);
    expect(moved.tokens[0]).not.toBe(first.tokens[0]);
    expect(moved.tokens[1]).toBe(first.tokens[1]);
  });

  test("in a list, an item that reads the same is last time's wherever it moved", () => {
    const first = map(0);
    const [vex, kor] = first.tokens;
    const next = kept(first, {
      ...map(0),
      tokens: [
        { id: "kor", x: 1, y: 1 },
        { ...vex!, x: 1 },
      ],
    });
    expect(next.tokens[0]).toBe(kor);
    expect(next.tokens[1]).toEqual({ id: "vex", x: 1, y: 0 });
  });

  test("a part gone or added is a change", () => {
    expect(kept({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(kept([1], [1, 2])).toEqual([1, 2]);
    expect(kept({ a: [1] }, { a: { 0: 1 } })).toEqual({ a: { 0: 1 } });
  });
});
