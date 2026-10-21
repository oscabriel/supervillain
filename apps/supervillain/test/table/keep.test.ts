import { describe, expect, test } from "bun:test";
import { keepLines } from "../../src/table/keep.ts";

type Seg = { readonly text: string; readonly tone: string };
const seg = (text: string, tone = "text"): Seg => ({ text, tone });

describe("keepLines", () => {
  test("a line that reads the same is last time's object, wherever it moved", () => {
    const keep = keepLines<Seg>();
    const first = keep([[seg("a")], [seg("b"), seg("c")]]);
    const second = keep([[seg("x")], [seg("a")], [seg("b"), seg("c")]]);
    expect(second[1]).toBe(first[0]);
    expect(second[2]).toBe(first[1]);
  });

  test("a changed line keeps the segments that didn't change, by place", () => {
    const keep = keepLines<Seg>();
    const [before] = keep([[seg("Vex "), seg("14/21", "healthy")]]);
    const [after] = keep([[seg("Vex "), seg("13/21", "healthy")]]);
    expect(after).not.toBe(before);
    expect(after![0]).toBe(before![0]);
    expect(after![1]).toEqual(seg("13/21", "healthy"));
  });

  test("the same input twice gives the same array back, so nothing is drawn again", () => {
    const keep = keepLines<Seg>();
    const first = keep([[seg("a")], [seg("b")]]);
    expect(keep([[seg("a")], [seg("b")]])).toBe(first);
  });
});
