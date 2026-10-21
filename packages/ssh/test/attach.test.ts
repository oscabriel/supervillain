import { describe, expect } from "bun:test";
import { connect, type Socket } from "node:net";
import { Deferred, Effect } from "effect";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

describe("attach", () => {
  effect("a socket the server dialed out serves SSH to whoever is on the far end", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({
        onExec: (session) =>
          Effect.sync(() => {
            session.write(`${session.info.identity.actor} ran ${session.command}`);
            return 0;
          }),
      });
      // The "relay": a listener the server dials. What it accepts is the SSH client's end of the link.
      const farEnd = yield* Deferred.make<Socket>();
      const relay = yield* tcpListener((socket) =>
        Deferred.doneUnsafe(farEnd, Effect.succeed(socket)),
      );
      const dialed = connect(relay.port, "127.0.0.1");
      server.attach(dialed);
      const link = yield* Deferred.await(farEnd);
      // OpenSSH can't speak over a socket we hand it, so a forwarder joins it to the link.
      const forwarder = yield* tcpListener((socket) => {
        socket.pipe(link);
        link.pipe(socket);
      });
      const result = yield* sshExec(forwarder.port, ["hello"], { key });
      expect(result).toMatchObject({ stdout: `key:${key.fingerprint} ran hello`, exitCode: 0 });
    }),
  );
});
