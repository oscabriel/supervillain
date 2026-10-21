import { describe, expect } from "bun:test";
import { connect, type Socket } from "node:net";
import { Deferred, Effect } from "effect";
import { effect } from "./effect.ts";
import { clientKey } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

/** A server whose exec prints the relayed actor, or `-`, after an optional pause. */
const relayServer = (
  trustedRelayKeys: ReadonlyArray<string>,
  pause: `${number} millis` = "0 millis",
) =>
  testServer({
    trustedRelayKeys,
    onExec: (session) =>
      Effect.gen(function* () {
        yield* Effect.sleep(pause);
        session.write(session.info.relayedActor ?? "-");
        return 0;
      }),
  });

describe("relay trust", () => {
  effect("SV_ACTOR from a trusted relay key seats a well-formed player; nothing else starts", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const relayKey = yield* clientKey(dir, "relay");
      const server = yield* relayServer([relayKey.fingerprint]);
      const client = yield* ssh2Client({ port: server.port, key: relayKey });
      // A relay channel without a believable player is refused, never seated as the relay's own key.
      const relayed = (actor: string) =>
        ssh2Exec(client, "who", { SV_ACTOR: actor }).pipe(
          Effect.map((r) => r.stdout),
          Effect.catch(() => Effect.succeed("refused")),
        );
      expect(PLAYER).toHaveLength(54);
      expect(yield* relayed(PLAYER)).toBe(PLAYER);
      expect(yield* relayed("guest:Zx_9-q")).toBe("guest:Zx_9-q");
      for (const ignored of [
        "gm",
        "GM",
        "",
        "key:SHA256:tooShort",
        `${PLAYER}A`,
        `${PLAYER}\n`,
        "guest:",
        "guest:has space",
        `guest:${"x".repeat(65)}`,
        `key:${PLAYER}`,
      ]) {
        expect(yield* relayed(ignored)).toBe("refused");
      }
      expect(yield* Effect.flip(ssh2Exec(client, "who"))).toBeInstanceOf(Error);
    }),
  );

  effect("SV_ACTOR from any other key is ignored", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const relayKey = yield* clientKey(dir, "relay");
      const mallory = yield* clientKey(dir, "mallory");
      const server = yield* relayServer([relayKey.fingerprint]);
      const client = yield* ssh2Client({ port: server.port, key: mallory });
      expect((yield* ssh2Exec(client, "who", { SV_ACTOR: PLAYER })).stdout).toBe("-");
    }),
  );

  effect("attach can trust a relay key on that one connection", () =>
    Effect.gen(function* () {
      const relayKey = yield* clientKey(yield* tempDir, "relay");
      const server = yield* relayServer([]);
      const farEnd = yield* Deferred.make<Socket>();
      const relay = yield* tcpListener((socket) =>
        Deferred.doneUnsafe(farEnd, Effect.succeed(socket)),
      );
      server.attach(connect(relay.port, "127.0.0.1"), { trustedRelayKeys: [relayKey.fingerprint] });
      const linked = yield* ssh2Client({ sock: yield* Deferred.await(farEnd), key: relayKey });
      expect((yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout).toBe(PLAYER);
      // The same key straight to the port is just a player.
      const direct = yield* ssh2Client({ port: server.port, key: relayKey });
      expect((yield* ssh2Exec(direct, "who", { SV_ACTOR: PLAYER })).stdout).toBe("-");
    }),
  );

  effect("a relay connection carries many sessions; an ordinary one only a few", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const relayKey = yield* clientKey(dir, "relay");
      const alice = yield* clientKey(dir, "alice");
      const server = yield* relayServer([relayKey.fingerprint], "300 millis");
      const relay = yield* ssh2Client({ port: server.port, key: relayKey });
      const many = yield* Effect.all(
        Array.from({ length: 8 }, () => ssh2Exec(relay, "who", { SV_ACTOR: PLAYER })),
        { concurrency: "unbounded" },
      );
      expect(many.map((r) => r.stdout)).toEqual(Array(8).fill(PLAYER));

      const player = yield* ssh2Client({ port: server.port, key: alice });
      const few = yield* Effect.all(
        Array.from({ length: 3 }, () => Effect.result(ssh2Exec(player, "who"))),
        { concurrency: "unbounded" },
      );
      expect(few.filter((r) => r._tag === "Success")).toHaveLength(2);
      // Finished sessions give their places back.
      expect((yield* ssh2Exec(player, "who")).stdout).toBe("-");
    }),
  );
});
