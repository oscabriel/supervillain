import type { Line } from "../src/index.ts";

export const at = "2026-10-20T19:00:00.000Z";

export const line = (
	seq: number,
	type: string,
	payload: Readonly<Record<string, number | string>>,
	actor = "gm"
): Line => ({ actor, seq, timestamp: at, type, payload });

export const text = (...lines: ReadonlyArray<Line>) =>
	lines.map((entry) => `${JSON.stringify(entry)}\n`).join("");
