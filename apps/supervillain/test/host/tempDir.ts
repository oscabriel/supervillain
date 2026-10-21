import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

/** A fresh folder that lives as long as the test's scope. */
export const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "sv-host-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);
