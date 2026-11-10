import { describe, expect, test } from "bun:test";
import { parseLog } from "../src/index.ts";

const line = (seq: number, type = "chat.posted", payload: unknown = { text: `line ${seq}` }) =>
  JSON.stringify({ actor: "gm", seq, timestamp: "2026-10-20T19:00:00.000Z", type, payload }) + "\n";

describe("parseLog", () => {
  test("reads every complete line as an envelope", () => {
    const text = line(1) + line(2, "dice.rolled", { total: 7 });
    const parsed = parseLog(text);
    expect(parsed.envelopes).toEqual([
      {
        actor: "gm",
        seq: 1,
        timestamp: "2026-10-20T19:00:00.000Z",
        type: "chat.posted",
        payload: { text: "line 1" },
      },
      {
        actor: "gm",
        seq: 2,
        timestamp: "2026-10-20T19:00:00.000Z",
        type: "dice.rolled",
        payload: { total: 7 },
      },
    ]);
    expect(parsed.intact).toBe(text);
    expect(parsed.torn).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  test("sets aside a last line with no newline as torn", () => {
    const whole = line(1) + line(2);
    const parsed = parseLog(whole + '{"actor":"gm","seq":3,"times');
    expect(parsed.envelopes.map((e) => e.seq)).toEqual([1, 2]);
    expect(parsed.intact).toBe(whole);
    expect(parsed.torn).toBe('{"actor":"gm","seq":3,"times');
    expect(parsed.error).toBeUndefined();
  });

  test("stops at a line that isn't JSON and names it", () => {
    const parsed = parseLog(line(1) + "not json\n" + line(3));
    expect(parsed.envelopes.map((e) => e.seq)).toEqual([1]);
    expect(parsed.error).toEqual({ line: 2, message: "expected a valid JSON string" });
  });

  test("stops at a line that isn't an envelope and names the field that's wrong", () => {
    const missing = parseLog(line(1) + '{"actor":"gm","seq":2}\n');
    expect(missing.envelopes.map((e) => e.seq)).toEqual([1]);
    expect(missing.error).toEqual({ line: 2, message: "timestamp: missing" });
    const wrong = parseLog(line(1).replace('"seq":1', '"seq":"1"'));
    expect(wrong.error).toEqual({ line: 1, message: "seq: expected number" });
  });

  test("stops where seq is not the line number, so a lost or repeated line shows", () => {
    const parsed = parseLog(line(1) + line(2) + line(2) + line(3));
    expect(parsed.envelopes.map((e) => e.seq)).toEqual([1, 2]);
    expect(parsed.error).toEqual({ line: 3, message: "seq 2 on line 3" });
  });
});
