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

  effect(
    "an RSA key logs in as itself with OpenSSH's defaults, even offered before another key",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const rsa = yield* clientKey(dir, "rsa", "rsa");
        const ed = yield* clientKey(dir, "ed", "ed25519");
        const { port } = yield* whoami(false);
        // OpenSSH signs with rsa-sha2-*, and gives up on a server whose PK_OK names ssh-rsa instead.
        const alone = yield* sshExec(port, ["whoami"], { key: rsa });
        expect(alone.stderr).toBe("");
        expect(alone.exitCode).toBe(0);
        expect(alone.stdout).toBe(`key:${rsa.fingerprint}`);
        // ssh tries ~/.ssh/id_rsa first by default: the key it offers first is who you are.
        const both = yield* sshExec(port, ["whoami"], { key: ed, flags: ["-i", rsa.path] });
        expect(both.exitCode).toBe(0);
        expect(both.stdout).toBe(`key:${rsa.fingerprint}`);
      }),
  );

  effect(
    "an RSA key its client restricts to rsa-sha2-512 isn't offered, as ssh2 never advertises it",
    () =>
      Effect.gen(function* () {
        // ssh2 1.16's server-sig-algs is missing a comma (sendExtInfo in lib/protocol/Protocol.js):
        // it says `ecdsa-sha2-nistp521rsa-sha2-512`, so rsa-sha2-512 is never named. The list is a
        // fixed string private to that module, and the server's options can't replace it, so only
        // patching ssh2 would fix it, and we don't patch dependencies. OpenSSH's defaults sign with
        // rsa-sha2-256 then, and log in (the test above). Only a client restricted to rsa-sha2-512
        // skips its RSA key; docs/PLAYING.md says what to do. If this fails, ssh2 fixed it: drop
        // that note and this test.
        const rsa = yield* clientKey(yield* tempDir, "rsa", "rsa");
        const { port } = yield* whoami(false);
        const only512 = yield* sshExec(port, ["whoami"], {
          key: rsa,
          flags: ["-v", "-o", "PubkeyAcceptedAlgorithms=rsa-sha2-512"],
        });
        const advertised = /server-sig-algs=<([^>]*)>/.exec(only512.stderr)?.[1]?.split(",");
        expect(advertised).toContain("rsa-sha2-256");
        expect(advertised).not.toContain("rsa-sha2-512");
        expect(only512.exitCode).toBe(255);
        expect(only512.stderr).toContain("Permission denied");
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
