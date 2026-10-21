import { join } from "node:path";
import { type ExecSession, type SessionInfo, type SshError, serve } from "@supervillain/ssh";
import { Clock, Context, Effect, Layer } from "effect";
import { CampaignContent } from "../content/index.ts";
import { plainText } from "../game/index.ts";
import { execLine, runLine } from "./line.ts";
import { Presence } from "./Presence.ts";
import { mountTable, openSeat } from "./Seat.ts";
import { type Rate, rateLimiter } from "./rate.ts";
import type { TableServices } from "./services.ts";
import { TableRoom } from "./TableRoom.ts";

export interface TableServerOptions {
  readonly campaignDir: string;
  readonly room: string;
  readonly port: number;
  readonly bind: string;
  /**
   * How fast one address may run one-off commands, each a new connection, whatever they are.
   * What those commands write is held to the room's rate as well, by `rateKeyOf`.
   */
  readonly execRate?: Rate;
}

/** Plenty for a person or a script at a table; a flood from one address is turned away. */
const EXEC_RATE: Rate = { burst: 20, perSecond: 2 };

const NO_PTY =
  "supervillain needs a terminal: run ssh -t, or one command at a time, e.g. ssh … help";
const SHUTDOWN = "The GM closed the table.";

/** The player a session speaks for: the one a trusted relay seated, else the connection's own. */
const actorOf = (info: SessionInfo) => info.relayedActor ?? info.identity.actor;

/**
 * Whose rate a session's lines count against. A key is one person wherever they connect from,
 * so it is rated as itself. Keys cost nothing to make, so one address could seat a fresh key per
 * session; that's accepted, and the per-address connection and session caps bound it. A guest is a new actor every connection, so a direct guest is rated
 * by its address. Behind a relay every player shares the relay's address, and only the relay
 * sees theirs: a relayed guest is rated as that guest of that relay, keyed by the relay's own
 * key so one relay's guest ids never spend another relay's players' rate. Keeping guest ids
 * stable per person is then the relay's job, as the trusted end that sees their addresses.
 */
export const rateKeyOf = (info: SessionInfo): string => {
  const actor = actorOf(info);
  if (actor.startsWith("key:")) return actor;
  if (info.relayedActor !== undefined) return `relay:${info.identity.actor}/${actor}`;
  return `address:${info.remoteAddress}`;
};

/** Runs one exec command as an input line and prints what it came to. Its number is the exit status. */
const execCommand = (session: ExecSession, allowed: (address: string, now: number) => boolean) =>
  Effect.gen(function* () {
    const actor = actorOf(session.info);
    if (!allowed(session.info.remoteAddress, yield* Clock.currentTimeMillis)) {
      session.writeError("Too many commands from your address; wait a moment.\n");
      return 1;
    }
    const reply = yield* runLine(actor, execLine(session.command), "exec", rateKeyOf(session.info));
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
  ): Layer.Layer<TableServer, SshError, TableServices> =>
    Layer.effect(
      TableServer,
      Effect.gen(function* () {
        // Sessions run on the server's own fibers and get the table's services from here.
        // Only those: the layer's whole context would carry its Scope too, and a seat's
        // finalizers would wait for the server to close instead of its own session.
        const services = Context.make(TableRoom, yield* TableRoom).pipe(
          Context.add(Presence, yield* Presence),
          Context.add(CampaignContent, yield* CampaignContent),
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
              const view = yield* openSeat({
                actor,
                rateKey: rateKeyOf(session.info),
                room: options.room,
                leave: session.close,
              });
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
