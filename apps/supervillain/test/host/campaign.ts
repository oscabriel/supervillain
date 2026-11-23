import { cp } from "node:fs/promises";
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
