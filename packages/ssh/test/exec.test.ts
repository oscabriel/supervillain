import { describe, expect } from "bun:test";
import { Effect } from "effect";
import type { ExecSession } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

describe("exec", () => {
  effect(
    "reaches onExec with the command and the key's identity; output and status come back",
    () =>
      Effect.gen(function* () {
        const key = yield* clientKey(yield* tempDir, "alice");
        const seen: ExecSession[] = [];
        const server = yield* testServer({
          onExec: (session) =>
            Effect.sync(() => {
              seen.push(session);
              session.write(`you said: ${session.command}\n`);
              session.writeError("a warning\n");
              return 3;
            }),
        });
        const result = yield* sshExec(server.port, ["hello", "world"], { key, user: "den" });
        expect(result).toEqual({
          stdout: "you said: hello world\n",
          stderr: "a warning\n",
          exitCode: 3,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.command).toBe("hello world");
        expect(seen[0]!.info.identity).toEqual({
          kind: "key",
          actor: `key:${key.fingerprint}`,
          fingerprint: key.fingerprint,
          algorithm: "ssh-ed25519",
        });
        expect(seen[0]!.info.user).toBe("den");
        expect(seen[0]!.info.remoteAddress).toBe("127.0.0.1");
        expect(seen[0]!.info.relayedActor).toBeUndefined();
      }),
  );

  effect("keeps only allow-listed client env with clean values", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const seen: ExecSession[] = [];
      const server = yield* testServer({
        onExec: (session) => Effect.sync(() => (seen.push(session), 0)),
      });
      const client = yield* ssh2Client({ port: server.port, key });
      yield* ssh2Exec(client, "env", {
        COLORTERM: "truecolor",
        TERM_PROGRAM: "evil\x1b]0;pwned\x07",
        LD_PRELOAD: "/tmp/x.so",
        SV_ACTOR: "gm",
      });
      expect(seen[0]!.info.env).toEqual({ COLORTERM: "truecolor" });
      expect(seen[0]!.info.relayedActor).toBeUndefined();
    }),
  );
});
