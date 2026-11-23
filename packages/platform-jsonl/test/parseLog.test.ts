import { describe, expect, test } from "bun:test";

import { parseLog } from "../src/index.ts";

const rawWith = (
	seq: number,
	type: string,
	payload: Readonly<Record<string, number | string>>
) =>
	`${JSON.stringify({ actor: "gm", seq, timestamp: "2026-10-20T19:00:00.000Z", type, payload })}\n`;

const raw = (seq: number) =>
	rawWith(seq, "chat.posted", { text: `line ${seq}` });

describe("parseLog", () => {
	test("reads every complete line as an envelope", () => {
		const whole = raw(1) + rawWith(2, "dice.rolled", { total: 7 });
		const parsed = parseLog(whole);
		expect(parsed.lines).toEqual([
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
		expect(parsed.intact).toBe(whole);
		expect(parsed.torn).toBeUndefined();
		expect(parsed.error).toBeUndefined();
	});

	test("sets aside a last line with no newline as torn", () => {
		const whole = raw(1) + raw(2);
		const parsed = parseLog(`${whole}{"actor":"gm","seq":3,"times`);
		expect(parsed.lines.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(parsed.intact).toBe(whole);
		expect(parsed.torn).toBe('{"actor":"gm","seq":3,"times');
		expect(parsed.error).toBeUndefined();
	});

	test("stops at a line that isn't JSON and names it", () => {
		const parsed = parseLog(`${raw(1)}not json\n${raw(3)}`);
		expect(parsed.lines.map((entry) => entry.seq)).toEqual([1]);
		expect(parsed.error).toEqual({
			line: 2,
			message: "expected a valid JSON string",
		});
	});

	test("stops at a line that isn't an envelope and names the field that's wrong", () => {
		const missing = parseLog(`${raw(1)}{"actor":"gm","seq":2}\n`);
		expect(missing.lines.map((entry) => entry.seq)).toEqual([1]);
		expect(missing.error).toEqual({ line: 2, message: "timestamp: missing" });
		const wrong = parseLog(raw(1).replace('"seq":1', '"seq":"1"'));
		expect(wrong.error).toEqual({ line: 1, message: "seq: expected number" });
	});

	test("stops where seq is not the line number, so a lost or repeated line shows", () => {
		const parsed = parseLog(raw(1) + raw(2) + raw(2) + raw(3));
		expect(parsed.lines.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(parsed.error).toEqual({ line: 3, message: "seq 2 on line 3" });
	});

	test("reads an empty log as no lines", () => {
		expect(parseLog("")).toEqual({ lines: [], intact: "" });
	});
});
