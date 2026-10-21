import { describe, expect } from "bun:test";
import { Effect } from "effect";
import type { Identity } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client } from "./ssh2client.ts";
import { tempDir } from "./tempDir.ts";

/** A server whose exec prints the caller's actor. */
const whoami = (allowGuests: boolean) => {
  const seen: Identity[] = [];
  return testServer({
    allowGuests,
    onExec: (session) =>
      Effect.sync(() => {
        seen.push(session.info.identity);
        session.write(session.info.identity.actor);
        return 0;
      }),
  }).pipe(Effect.map((server) => ({ port: server.port, seen })));
};

describe("identity", () => {
  effect("two keys are two actors, and the same key is the same actor again", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const alice = yield* clientKey(dir, "alice");
      const bob = yield* clientKey(dir, "bob");
      const { port } = yield* whoami(false);
      const a1 = yield* sshExec(port, ["whoami"], { key: alice });
      const b = yield* sshExec(port, ["whoami"], { key: bob });
      const a2 = yield* sshExec(port, ["whoami"], { key: alice });
      expect(a1.stdout).toBe(`key:${alice.fingerprint}`);
      expect(b.stdout).toBe(`key:${bob.fingerprint}`);
      expect(a2.stdout).toBe(a1.stdout);
      expect(alice.fingerprint).not.toBe(bob.fingerprint);
    }),
  );

  effect("a client with no key is refused unless guests are allowed", () =>
    Effect.gen(function* () {
      const { port, seen } = yield* whoami(false);
      const refused = yield* sshExec(port, ["whoami"]);
      expect(refused.exitCode).toBe(255);
      expect(refused.stderr).toContain("Permission denied");
      // A client that tries keyboard-interactive although it is not offered gets nowhere either.
      const forced = yield* Effect.flip(ssh2Client({ port, keyboard: true }));
      expect(forced.message).toContain("authentication methods failed");
      expect(seen).toEqual([]);
    }),
  );

  effect("a client with no key is a guest when guests are allowed, a new one each connection", () =>
    Effect.gen(function* () {
      const { port, seen } = yield* whoami(true);
      const first = yield* sshExec(port, ["whoami"]);
      const second = yield* sshExec(port, ["whoami"]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toMatch(/^guest:[A-Za-z0-9_-]{1,64}$/);
      expect(second.stdout).toMatch(/^guest:[A-Za-z0-9_-]{1,64}$/);
      expect(second.stdout).not.toBe(first.stdout);
      expect(seen.map((i) => i.kind)).toEqual(["guest", "guest"]);
    }),
  );

  effect("a key holder is still a key when guests are allowed", () =>
    Effect.gen(function* () {
      const alice = yield* clientKey(yield* tempDir, "alice");
      const { port } = yield* whoami(true);
      expect((yield* sshExec(port, ["whoami"], { key: alice })).stdout).toBe(
        `key:${alice.fingerprint}`,
      );
    }),
  );
});
