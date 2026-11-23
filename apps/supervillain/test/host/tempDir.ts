import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

export const tempDir = Effect.acquireRelease(
	Effect.promise(async () => await mkdtemp(path.join(tmpdir(), "sv-host-"))),
	(dir) =>
		Effect.promise(async () => {
			await rm(dir, { recursive: true, force: true });
		})
);
