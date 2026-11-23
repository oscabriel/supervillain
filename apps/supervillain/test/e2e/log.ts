import { readFile } from "node:fs/promises";
import path from "node:path";

import { LineJson } from "@supervillain/platform-jsonl";
import { Effect, Schema } from "effect";

const decodeLine = Schema.decodeUnknownSync(LineJson);

export const linesIn = (text: string) =>
	text
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => decodeLine(l));

export const readLog = async (dir: string) =>
	linesIn(await readFile(path.join(dir, "events.jsonl"), "utf-8"));

export const logOf = (dir: string) =>
	Effect.promise(async () => await readLog(dir));

export const pollFor = async <A>(
	check: () => Promise<A | undefined> | A | undefined,
	failure: () => string,
	ms: number
): Promise<A> => {
	const deadline = performance.now() + ms;

	const attempt = async (): Promise<A> => {
		const found = await check();

		if (found !== undefined) {
			return found;
		}

		if (performance.now() > deadline) {
			throw new Error(failure());
		}

		await Bun.sleep(20);

		return await attempt();
	};

	return await attempt();
};
