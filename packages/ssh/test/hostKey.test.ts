import { describe, expect } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { serve } from "../src/index.ts";
import { effect } from "./effect.ts";
import { keygenFingerprint } from "./openssh.ts";
import { tempDir } from "./tempDir.ts";

const fingerprintOf = (hostKeyPath: string) =>
  Effect.scoped(
    serve({ hostKeyPath, port: 0, host: "127.0.0.1", onShell: () => Effect.void }).pipe(
      Effect.map((server) => server.hostKeyFingerprint),
    ),
  );

describe("host key", () => {
  effect("is created as an owner-only ed25519 key on first serve, and reused after", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "campaign", "host_key");
      const first = yield* fingerprintOf(path);
      const mode = (yield* Effect.promise(() => stat(path))).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(first).toBe(yield* keygenFingerprint(path));
      expect(yield* fingerprintOf(path)).toBe(first);
    }),
  );

  effect("is refused when other users can read it, as sshd refuses one", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "host_key");
      yield* fingerprintOf(path);
      yield* Effect.promise(() => chmod(path, 0o644));
      const error = yield* Effect.flip(fingerprintOf(path));
      expect(error.message).toContain("chmod 600");
    }),
  );
});
