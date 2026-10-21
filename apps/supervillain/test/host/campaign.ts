import { cp } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./tempDir.ts";

/** The sample campaign in the repo: four heroes and four bandits. */
export const SAMPLE = join(import.meta.dir, "../../../../examples/campaign");

/** A copy of the sample campaign in a fresh folder that lives as long as the test's scope. */
export const sampleCampaign = Effect.gen(function* () {
  const dir = yield* tempDir;
  yield* Effect.promise(() => cp(SAMPLE, dir, { recursive: true }));
  return dir;
});
