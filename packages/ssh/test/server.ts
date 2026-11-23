import path from "node:path";

import { Effect } from "effect";

import { serve } from "../src/index.ts";
import type { ServeOptions } from "../src/index.ts";
import { tempDir } from "./tempDir.ts";

export const testServer = (options: Partial<ServeOptions> = {}) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;

		return yield* serve({
			hostKeyPath: path.join(dir, "host_key"),
			port: 0,
			host: "127.0.0.1",
			onShell: () => Effect.void,
			...options,
		});
	});
