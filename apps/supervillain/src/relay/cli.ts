// `supervillain relay [--player-port 2222] [--gm-port 7022] [--bind 0.0.0.0] [--claim-days 180]
//                     [--dir ~/.supervillain-relay]`
// `supervillain relay forget <room> [--dir …]`
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { DEFAULT_GM_PORT, DEFAULT_PLAYER_PORT, isRoomName } from "./protocol.ts";
import { checkRelayDir, forgetRoom } from "./rooms.ts";
import { Relay, RelayError } from "./server.ts";

const DEFAULT_DIR = "~/.supervillain-relay";
const DEFAULT_CLAIM_DAYS = 180;

const expandHome = (path: string) =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const relayDir = (dir: string) => resolve(expandHome(dir));

/** Prints a failure plainly and sets the exit status, as main.ts does for its own commands. */
const fail = (e: { readonly message: string }) =>
  Console.error(`supervillain: ${e.message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

const relay = Command.make("relay", {
  playerPort: Flag.Int("player-port").pipe(
    Flag.withDefault(DEFAULT_PLAYER_PORT),
    Flag.withDescription("SSH port for players: ssh -p <port> <room>@<this host> (0 picks one)"),
  ),
  gmPort: Flag.Int("gm-port").pipe(
    Flag.withDefault(DEFAULT_GM_PORT),
    Flag.withDescription("Port GMs' hosts dial with --relay (0 picks one)"),
  ),
  bind: Flag.String("bind").pipe(
    Flag.withDefault("0.0.0.0"),
    Flag.withDescription("Address to listen on, both ports"),
  ),
  claimDays: Flag.Int("claim-days").pipe(
    Flag.withDefault(DEFAULT_CLAIM_DAYS),
    Flag.withDescription(
      "Days a room's claim lasts with no GM linked, before another GM may take it",
    ),
  ),
}).pipe(
  Command.withSharedFlags({
    dir: Flag.String("dir").pipe(
      Flag.withDefault(DEFAULT_DIR),
      Flag.withDescription("Holds the relay's keys and rooms.json, which GM holds each room"),
    ),
  }),
);

const run = relay.pipe(
  Command.withHandler((o) =>
    Effect.gen(function* () {
      const dir = relayDir(o.dir);
      if (o.claimDays < 1)
        return yield* new RelayError({
          message: `--claim-days takes a number of days from 1, not ${o.claimDays}`,
        });
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true, mode: 0o700 }),
        catch: (e) =>
          new RelayError({ message: `can't make ${dir}: ${e instanceof Error ? e.message : e}` }),
      });
      const info = yield* Relay.make({
        dir,
        playerPort: o.playerPort,
        gmPort: o.gmPort,
        bind: o.bind,
        gm: { claimDays: o.claimDays },
      });
      const shown = o.bind === "0.0.0.0" || o.bind === "::" ? "<this host>" : o.bind;
      yield* Console.log(`supervillain relay: keeping its keys and rooms in ${dir}`);
      yield* Console.log(`players join with: ssh -p ${info.playerPort} <room>@${shown}`);
      yield* Console.log(
        `GMs dial ${o.bind}:${info.gmPort} (supervillain host --relay ${shown}:${info.gmPort})`,
      );
      yield* Console.log(`relay key ${info.relayKeyFingerprint}`);
      yield* Console.log(`  GMs pin it with: --relay-key ${info.relayKeyFingerprint}`);
      yield* Console.log(`host key ${info.hostKeyFingerprint} (what players' ssh sees)`);
      yield* Console.log(
        `a room's claim lapses after ${o.claimDays} day${o.claimDays === 1 ? "" : "s"} with no GM linked`,
      );
      return yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.catchTags({ RelayError: fail, RoomsError: fail, SshError: fail }),
    ),
  ),
);

const forget = Command.make(
  "forget",
  {
    room: Argument.String("room").pipe(Argument.withDescription("The room to release")),
  },
  (o) =>
    Effect.gen(function* () {
      const { dir } = yield* relay;
      if (!isRoomName(o.room))
        return yield* new RelayError({
          message: `${JSON.stringify(o.room)} isn't a room name (1-32 of a-z, 0-9 and -, starting with a letter)`,
        });
      const folder = relayDir(dir);
      // A wrong or missing --dir would otherwise read as "nobody holds it", and say nothing.
      yield* Effect.tryPromise({
        try: () => access(join(folder, "relay_key")),
        catch: () =>
          new RelayError({
            message: `${folder} holds no relay (it has no relay_key); pass the relay's folder with --dir`,
          }),
      });
      yield* checkRelayDir(folder);
      const rooms = join(folder, "rooms.json");
      const holder = yield* forgetRoom(rooms, o.room);
      if (holder === undefined)
        return yield* Console.log(`supervillain: no GM holds room ${o.room} in ${rooms}`);
      yield* Console.log(
        `supervillain: released room ${o.room} in ${rooms}, held by GM host key ${holder}`,
      );
      yield* Console.log(
        "The next GM to link it claims it, and replaces the GM linked now, if one is.",
      );
    }).pipe(Effect.catchTags({ RelayError: fail, RoomsError: fail })),
).pipe(Command.withDescription("Release a room's claim, so another GM's host key can take it"));

export const relayCommand = run.pipe(
  Command.withDescription(
    "Run a relay: players ssh to it, GMs' hosts dial out to it, and it carries the bytes between",
  ),
  Command.withSubcommands([forget]),
);
