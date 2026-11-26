import { appendFile, cp } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { tempDir } from "./tempDir.ts";

export const SAMPLE = path.join(
	import.meta.dir,
	"../../../../examples/campaign"
);

export const sampleCampaign = Effect.gen(function* () {
	const dir = yield* tempDir;

	yield* Effect.promise(async () => {
		await cp(SAMPLE, dir, { recursive: true });
	});

	return dir;
});

export const DOOR_OPEN_LINE = JSON.stringify({
	actor: "gm",
	seq: 1,
	timestamp: "1970-01-01T00:00:00.000Z",
	type: "core.door-set",
	payload: { door: "open" },
});

export const DOOR_OPEN_NOTE =
	"The door is open: anyone who connects sits down.";

export const openDoor = (dir: string) =>
	Effect.promise(async () => {
		await appendFile(path.join(dir, "events.jsonl"), `${DOOR_OPEN_LINE}\n`, {
			mode: 0o600,
		});
	});

export const openCampaign = Effect.gen(function* () {
	const dir = yield* tempDir;
	yield* openDoor(dir);

	return dir;
});

export const openSampleCampaign = Effect.gen(function* () {
	const dir = yield* sampleCampaign;
	yield* openDoor(dir);

	return dir;
});
