import { join } from "node:path";
import { Effect } from "effect";
import { type ServeOptions, serve } from "../src/index.ts";
import { tempDir } from "./tempDir.ts";

/** A server on a free loopback port with a fresh host key, for the life of the test's scope. */
export const testServer = (options: Partial<ServeOptions> = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    return yield* serve({
      hostKeyPath: join(dir, "host_key"),
      port: 0,
      host: "127.0.0.1",
      onShell: () => Effect.void,
      ...options,
    });
  });
