import { join } from "node:path";
import { type ExecSession, type SessionInfo, type SshError, serve } from "@supervillain/ssh";
import { Clock, Context, Effect, Layer } from "effect";
import { plainText } from "../game/index.ts";
import { execLine, runLine } from "./line.ts";
import { Presence } from "./Presence.ts";
import { mountTable, openSeat } from "./Seat.ts";
import { type Rate, rateLimiter } from "./rate.ts";
import { TableRoom } from "./TableRoom.ts";

export interface TableServerOptions {
  readonly campaignDir: string;
  readonly room: string;
  readonly port: number;
  readonly bind: string;
  /** How fast one address may run one-off commands. Guests are new actors each time, so it's by address. */
  readonly execRate?: Rate;
}

/** Plenty for a person or a script at a table; a flood from one address is turned away. */
const EXEC_RATE: Rate = { burst: 20, perSecond: 2 };

const NO_PTY =
  "supervillain needs a terminal: run ssh -t, or one command at a time, e.g. ssh … help";
const SHUTDOWN = "The GM closed the table.";

/** The player a session speaks for: the one a trusted relay seated, else the connection's own. */
const actorOf = (info: SessionInfo) => info.relayedActor ?? info.identity.actor;

/** Runs one exec command as an input line and prints what it came to. Its number is the exit status. */
const execCommand = (session: ExecSession, allowed: (address: string, now: number) => boolean) =>
  Effect.gen(function* () {
    const actor = actorOf(session.info);
    if (!allowed(session.info.remoteAddress, yield* Clock.currentTimeMillis)) {
      session.writeError("Too many commands from your address; wait a moment.\n");
      return 1;
    }
    const reply = yield* runLine(actor, execLine(session.command), "exec");
    yield* Effect.logDebug(`exec ${actor}: ${reply.kind}`);
    switch (reply.kind) {
      case "done":
        for (const line of reply.lines) session.write(`${plainText(line)}\n`);
        return 0;
      case "message":
        session.write(`${reply.text}\n`);
        return 0;
      case "refusal":
        session.writeError(`${reply.text}\n`);
        return 1;
      case "empty":
        session.writeError("Nothing to send. Try: ssh … roll 2d10, or ssh … help\n");
        return 1;
    }
  });

/**
 * The table over SSH: each shell is a seat for its session's identity, each exec runs one line.
 * Keyless clients come in as guests. The server, and every session, lives as long as the layer.
 */
export class TableServer extends Context.Service<
  TableServer,
  { readonly port: number; readonly hostKeyFingerprint: string }
>()("supervillain/host/TableServer") {
  static readonly layer = (
    options: TableServerOptions,
  ): Layer.Layer<TableServer, SshError, TableRoom | Presence> =>
    Layer.effect(
      TableServer,
      Effect.gen(function* () {
        // Sessions run on the server's own fibers and get the room and presence from here.
        // Only those two: the layer's whole context would carry its Scope too, and a seat's
        // finalizers would wait for the server to close instead of its own session.
        const services = Context.make(TableRoom, yield* TableRoom).pipe(
          Context.add(Presence, yield* Presence),
        );
        const allowed = rateLimiter(options.execRate ?? EXEC_RATE);
        const server = yield* serve({
          hostKeyPath: join(options.campaignDir, "host_key"),
          port: options.port,
          host: options.bind,
          allowGuests: true,
          noPtyMessage: NO_PTY,
          shutdownNotice: SHUTDOWN,
          onShell: (session) =>
            Effect.gen(function* () {
              const actor = actorOf(session.info);
              const { cols, rows, remoteAddress } = session.info;
              yield* Effect.logInfo(`seat open: ${actor} from ${remoteAddress} (${cols}x${rows})`);
              yield* Effect.addFinalizer(() => Effect.logInfo(`seat closed: ${actor}`));
              const view = yield* openSeat({ actor, room: options.room, leave: session.close });
              yield* mountTable(session.renderer, view);
              // The session ends when the player leaves or goes; the server closes this scope then.
              return yield* Effect.never;
            }).pipe(Effect.provideContext(services)),
          onExec: (session) => execCommand(session, allowed).pipe(Effect.provideContext(services)),
        });
        return TableServer.of({ port: server.port, hostKeyFingerprint: server.hostKeyFingerprint });
      }),
    );
}
