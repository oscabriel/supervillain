import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

describe("connect rate", () => {
  effect("an address that connects faster than its rate is cut at once; others are not", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({
        limits: { connectRate: { burst: 2, perSecond: 0.001 } },
        onExec: (session) => Effect.sync(() => (session.write("ok"), 0)),
      });
      expect((yield* sshExec(server.port, ["x"], { key })).stdout).toBe("ok");
      expect((yield* sshExec(server.port, ["x"], { key })).stdout).toBe("ok");
      const third = yield* sshExec(server.port, ["x"], { key });
      expect(third.exitCode).toBe(255);
      // Another machine has its own allowance.
      yield* ssh2Client({ port: server.port, key, localAddress: "127.0.0.2" });
    }),
  );
});
