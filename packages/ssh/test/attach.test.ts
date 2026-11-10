import { describe, expect } from "bun:test";
import { connect, type Socket } from "node:net";
import { Deferred, Effect } from "effect";
import type { AttachOptions } from "../src/index.ts";
import { effect } from "./effect.ts";
import { clientKey, sshExec } from "./openssh.ts";
import { testServer } from "./server.ts";
import { ssh2Client, ssh2Exec } from "./ssh2client.ts";
import { tcpListener } from "./tcp.ts";
import { tempDir } from "./tempDir.ts";

const PLAYER = `key:SHA256:${"A1b2+/".repeat(7)}C`;

/** The "relay": a listener the server dials. What it accepts is the SSH client's end of the link. */
const dialed =
  (server: { attach: (socket: Socket, options?: AttachOptions) => void }) =>
  (options?: AttachOptions) =>
    Effect.gen(function* () {
      const farEnd = yield* Deferred.make<Socket>();
      const relay = yield* tcpListener((socket) =>
        Deferred.doneUnsafe(farEnd, Effect.succeed(socket)),
      );
      const near = connect(relay.port, "127.0.0.1");
      server.attach(near, options);
      return Object.assign(yield* Deferred.await(farEnd), { near });
    });

/** Whether the socket has closed yet. */
const watchClose = (socket: Socket) => {
  let closed = false;
  socket.once("close", () => (closed = true));
  return () => closed;
};

/** An exec handler that prints the session's relayed actor, or its own, and exits 0. */
const whoami = {
  onExec: (session: {
    info: { relayedActor?: string; identity: { actor: string } };
    write: (t: string) => void;
  }) =>
    Effect.sync(() => {
      session.write(session.info.relayedActor ?? session.info.identity.actor);
      return 0;
    }),
};

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
      const link = yield* dialed(server)();
      // OpenSSH can't speak over a socket we hand it, so a forwarder joins it to the link.
      const forwarder = yield* tcpListener((socket) => {
        socket.pipe(link);
        link.pipe(socket);
      });
      const result = yield* sshExec(forwarder.port, ["hello"], { key });
      expect(result).toMatchObject({ stdout: `key:${key.fingerprint} ran hello`, exitCode: 0 });
    }),
  );

  effect("a socket that closed before it was attached takes no place", () =>
    Effect.gen(function* () {
      const key = yield* clientKey(yield* tempDir, "alice");
      const server = yield* testServer({ ...whoami, limits: { connections: 1 } });
      const relay = yield* tcpListener(() => undefined);
      const gone = connect(relay.port, "127.0.0.1");
      yield* Effect.promise(() => new Promise<void>((r) => gone.once("connect", () => r())));
      gone.destroy();
      yield* Effect.promise(() => new Promise<void>((r) => gone.once("close", () => r())));
      server.attach(gone);
      // The server's one place is still free.
      expect((yield* sshExec(server.port, ["who"], { key })).exitCode).toBe(0);
    }),
  );

  effect("a persistent link carrying nobody outlives the session-start timer", () =>
    Effect.gen(function* () {
      const relayKey = yield* clientKey(yield* tempDir, "relay");
      const server = yield* testServer({ ...whoami, timeouts: { sessionStartMs: 150 } });
      const attach = dialed(server);
      const admit = { admitRelay: () => true };

      const persistent = yield* attach({ ...admit, persistent: true });
      const persistentClosed = watchClose(persistent);
      const linked = yield* ssh2Client({ sock: persistent, key: relayKey });
      // An ordinary attached link that carries nobody is cut, as a listened one is.
      const ordinary = yield* attach(admit);
      const ordinaryClosed = watchClose(ordinary);
      yield* ssh2Client({ sock: ordinary, key: relayKey });

      yield* Effect.sleep("500 millis");
      expect(ordinaryClosed()).toBe(true);
      expect(persistentClosed()).toBe(false);
      expect((yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout).toBe(PLAYER);
      // Its last session over, it is still not cut.
      yield* Effect.sleep("400 millis");
      expect(persistentClosed()).toBe(false);
      expect((yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout).toBe(PLAYER);
    }),
  );

  effect("a persistent link whose far end stops answering keepalives is cut", () =>
    Effect.gen(function* () {
      const relayKey = yield* clientKey(yield* tempDir, "relay");
      const server = yield* testServer({
        ...whoami,
        timeouts: { sessionStartMs: 100, keepaliveMs: 100, keepaliveCount: 2 },
      });
      const link = yield* dialed(server)({ admitRelay: () => true, persistent: true });
      // The far end, paused, would never hear the close: watch the server's own end.
      const closed = watchClose(link.near);
      yield* ssh2Client({ sock: link, key: relayKey });
      // The relay's machine goes quiet: nothing it receives is read or answered.
      link.pause();
      yield* Effect.promise(async () => {
        const start = Date.now();
        while (!closed() && Date.now() - start < 3000) await Bun.sleep(20);
      });
      expect(closed()).toBe(true);
    }),
  );

  effect("a relay link admits only the key its caller admits, as the relay", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const relayKey = yield* clientKey(dir, "relay");
      const mallory = yield* clientKey(dir, "mallory");
      const server = yield* testServer({ ...whoami, allowGuests: true });
      const attach = dialed(server);
      const asked: string[] = [];
      const admitRelay = (fingerprint: string) => {
        asked.push(fingerprint);
        return fingerprint === relayKey.fingerprint;
      };

      const linked = yield* ssh2Client({ sock: yield* attach({ admitRelay }), key: relayKey });
      expect((yield* ssh2Exec(linked, "who", { SV_ACTOR: PLAYER })).stdout).toBe(PLAYER);
      // The relay's channels must name their player.
      expect(yield* Effect.flip(ssh2Exec(linked, "who"))).toBeInstanceOf(Error);
      expect(asked).toEqual([relayKey.fingerprint]);

      // Any other key, or a guest, can't log in on a relay link at all.
      const refused = yield* Effect.flip(
        ssh2Client({ sock: yield* attach({ admitRelay }), key: mallory }),
      );
      expect(refused).toBeInstanceOf(Error);
      expect(asked).toEqual([relayKey.fingerprint, mallory.fingerprint]);
      const guest = yield* Effect.flip(
        ssh2Client({ sock: yield* attach({ admitRelay }), keyboard: true }),
      );
      expect(guest).toBeInstanceOf(Error);
    }),
  );
});
