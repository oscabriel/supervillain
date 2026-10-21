#!/usr/bin/env bun
// The one binary: `supervillain …` compiled (scripts/build.ts), `bun supervillain …` from the repo
// root, or this file from anywhere.
//   supervillain host [campaign-dir] [--port 2222] [--bind 127.0.0.1] [--room name] [--headless]
//                     [--relay host:port] [--relay-key SHA256:…] [--relay-player-port 2222]
//                     [--relay-host-key SHA256:…]
//   supervillain new <campaign-dir> [--example]
//   supervillain import <bestiary-json-path> --into <campaign-dir> [names...] [--overwrite]
//   supervillain check <campaign-dir>
//   supervillain relay [--player-port 2222] [--gm-port 7022] [--bind 0.0.0.0] [--dir ~/.supervillain-relay]
//   supervillain relay forget <room> [--dir …]
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Cause,
  Console,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Runtime,
  Schema,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { checkLog } from "./host/check.ts";
import { relayCommand } from "./relay/cli.ts";
import {
  isFingerprint,
  joinNote,
  linkAlert,
  parseRelayAddress,
  roomSlug,
} from "./host/RelayLink.ts";
import { isRoomName } from "./relay/protocol.ts";

/** A failure with a message for the person at the terminal: printed plainly, exit status 1. */
class CheckError extends Schema.TaggedError<CheckError>()("CheckError", {
  message: Schema.String,
}) {}

/** The same, for the host: a campaign folder it can't make, say. */
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

/** The same, for `new` and `import`: a folder that's taken, a bestiary that won't import. */
class CampaignError extends Schema.TaggedError<CampaignError>()("CampaignError", {
  message: Schema.String,
}) {}

/** Whether this is the compiled binary (scripts/build.ts), whose own files live in Bun's embedded fs. */
const COMPILED = import.meta.dir.startsWith("/$bunfs/");

/** The sample campaign `new --example` copies: embedded beside the code in the binary, else the repo's. */
const EXAMPLE = COMPILED
  ? join(import.meta.dir, "campaign")
  : join(import.meta.dir, "../../../examples/campaign");

/** How the person at the terminal runs this program again. */
const SELF = COMPILED ? "supervillain" : "bun supervillain";

/** Copies a folder file by file: `fs.cp` can't copy out of a binary's embedded files. */
const copyTree = async (from: string, to: string): Promise<void> => {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target);
      await copyTree(source, target);
    } else await writeFile(target, await readFile(source));
  }
};

/** Prints a failure plainly and sets the exit status. */
const fail = (e: { readonly message: string }) =>
  Console.error(`supervillain: ${e.message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How players reach this host, as one command to paste. */
const joinCommand = (room: string, bind: string, port: number) => {
  const address = bind === "0.0.0.0" || bind === "::" ? "<this machine's address>" : bind;
  return `ssh ${port === 22 ? "" : `-p ${port} `}${room}@${address}`;
};

const host = Command.make(
  "host",
  {
    campaignDir: Argument.String("campaign-dir").pipe(
      Argument.withDescription("Folder holding events.jsonl and the host key (default ./campaign)"),
      Argument.withDefault("campaign"),
    ),
    port: Flag.Int("port").pipe(
      Flag.withDefault(2222),
      Flag.withDescription("SSH port for players (0 picks a free one)"),
    ),
    bind: Flag.String("bind").pipe(
      Flag.withDefault("127.0.0.1"),
      Flag.withDescription("Address to listen on (0.0.0.0 for every interface)"),
    ),
    room: Flag.String("room").pipe(
      Flag.optional,
      Flag.withDescription("The room's name (default: the campaign folder's name, slugged)"),
    ),
    relay: Flag.String("relay").pipe(
      Flag.optional,
      Flag.withDescription(
        "Also take players through this relay (host:port, port 7022 if left out); the host dials it",
      ),
    ),
    relayKey: Flag.String("relay-key").pipe(
      Flag.optional,
      Flag.withDescription(
        "The relay's key fingerprint to trust (SHA256:…, the relay prints it); else <campaign>/relay_known, filled on first link",
      ),
    ),
    relayPlayerPort: Flag.Int("relay-player-port").pipe(
      Flag.optional,
      Flag.withDescription(
        "The relay's port for players, for the join command you're shown (default 2222, the relay's own)",
      ),
    ),
    relayHostKey: Flag.String("relay-host-key").pipe(
      Flag.optional,
      Flag.withDescription(
        "The relay's host key (SHA256:…, what players' ssh sees there; the relay prints it), shown with the join command for players to check",
      ),
    ),
    headless: Flag.Boolean("headless").pipe(
      Flag.withDefault(false),
      Flag.withDescription("No GM seat in this terminal; logs go to stdout"),
    ),
  },
  Effect.fn(function* (o) {
    const dir = resolve(o.campaignDir);
    const room = Option.getOrElse(o.room, () => roomSlug(basename(dir)));
    const relayText = Option.getOrUndefined(o.relay);
    const relayAddress = relayText === undefined ? undefined : parseRelayAddress(relayText);
    if (relayText !== undefined && relayAddress === undefined)
      return yield* new HostError({ message: `--relay takes host:port, not ${relayText}` });
    const relayKey = Option.getOrUndefined(o.relayKey);
    const relayPlayerPort = Option.getOrUndefined(o.relayPlayerPort);
    if (relayPlayerPort !== undefined && (relayPlayerPort < 1 || relayPlayerPort > 65_535))
      return yield* new HostError({
        message: `--relay-player-port takes a port from 1 to 65535, not ${relayPlayerPort}`,
      });
    if (relayKey !== undefined && !isFingerprint(relayKey))
      return yield* new HostError({
        message: `--relay-key takes a key fingerprint like SHA256:…, not ${relayKey}`,
      });
    const relayHostKey = Option.getOrUndefined(o.relayHostKey);
    if (relayHostKey !== undefined && !isFingerprint(relayHostKey))
      return yield* new HostError({
        message: `--relay-host-key takes a key fingerprint like SHA256:…, not ${relayHostKey}`,
      });
    if (relayAddress !== undefined && !isRoomName(room))
      return yield* new HostError({
        message: `a relay's room is 1-32 of a-z, 0-9 and -, starting with a letter: pick one with --room, not ${room}`,
      });
    // The log is every word said at the table: a new campaign folder is its owner's alone.
    yield* Effect.tryPromise({
      try: () => mkdir(dir, { recursive: true, mode: 0o700 }),
      catch: (e) =>
        new HostError({ message: `can't make the campaign folder ${dir}: ${messageOf(e)}` }),
    });
    // The table (OpenTUI and Solid) loads only here, so `check` never needs it. Its JSX needs the
    // Solid transform, which bunfig.toml preloads only when run from the repo root.
    yield* Effect.promise(() => import("../preload.ts"));
    const { tableServices } = yield* Effect.promise(() => import("./host/services.ts"));
    const { TableServer } = yield* Effect.promise(() => import("./host/TableServer.ts"));
    const { localSeat } = yield* Effect.promise(() => import("./host/LocalSeat.ts"));

    const layer = TableServer.layer({
      campaignDir: dir,
      room,
      port: o.port,
      bind: o.bind,
      ...(relayAddress === undefined
        ? {}
        : {
            relay: {
              ...relayAddress,
              ...(relayKey === undefined ? {} : { relayKey }),
              ...(relayPlayerPort === undefined ? {} : { playerPort: relayPlayerPort }),
            },
          }),
    }).pipe(Layer.provideMerge(tableServices(dir)));
    // The GM's seat owns this terminal, and log lines would tear its frame: they go to a file.
    const logs = o.headless
      ? Layer.empty
      : Logger.layer([
          Logger.toFile(Logger.formatSimple, join(dir, "host.log"), { flag: "a", mode: 0o600 }),
        ]);

    yield* Effect.gen(function* () {
      const server = yield* TableServer;
      const relay = server.relay;
      const direct = joinCommand(room, o.bind, server.port);
      const joining = relay?.joinCommand ?? direct;
      // Through a relay, players' ssh meets the relay's host key, never this table's.
      const relayHostKeyText =
        relayHostKey ?? "ask whoever runs the relay (it prints it as its host key)";
      yield* Console.log(`supervillain: hosting "${room}" from ${dir}`);
      yield* Console.log(`players join with: ${joining}${relay ? " (through the relay)" : ""}`);
      if (relay !== undefined && relayAddress !== undefined) {
        yield* Console.log(`  players' ssh sees the relay's host key: ${relayHostKeyText}`);
        yield* Console.log(`players here can also join directly: ${direct}`);
        yield* Console.log(
          `relay ${relayAddress.host}:${relayAddress.port}, trusting ${relayKey ?? `the key in ${join(dir, "relay_known")} (pinned on first link)`}`,
        );
      }
      yield* Console.log(
        `host key ${server.hostKeyFingerprint}${relay ? " (this table's: direct connections only)" : ""}`,
      );
      yield* Effect.logInfo(
        relay
          ? `hosting "${room}" on ${o.bind}:${server.port} (direct: ${direct}); through the relay: ${joining}`
          : `hosting "${room}" on ${o.bind}:${server.port}, players: ${joining}`,
      );
      if (o.headless) return yield* Effect.never;
      yield* localSeat({
        room,
        helpFooter: relay
          ? `Players join through the relay with: ${joining}\nThe relay's host key, which their ssh sees: ${relayHostKeyText}\nPlayers here can join directly: ${direct} (host key ${server.hostKeyFingerprint})`
          : `Players join with: ${joining}\nHost key: ${server.hostKeyFingerprint}`,
        joinHint: joining,
        ...(relay === undefined
          ? {}
          : {
              joinNote: {
                get: Effect.map(relay.status.get, (s) => joinNote(s, relay.joinCommand)),
                changes: Stream.map(relay.status.changes, (s) => joinNote(s, relay.joinCommand)),
              },
              alert: {
                get: Effect.map(relay.status.get, linkAlert),
                changes: Stream.map(relay.status.changes, linkAlert),
              },
            }),
      });
      yield* Effect.logInfo("the GM left the table; shutting down");
    }).pipe(Effect.provide(layer), Effect.provide(logs));
  }),
).pipe(
  Command.withDescription(
    "Open the table: the campaign log, the SSH server and (unless --headless) the GM's seat",
  ),
);

/** Whether `dir` is missing or empty, so `new` can make a campaign there without losing anything. */
const isFree = (dir: string) =>
  readdir(dir).then(
    (names) => names.length === 0,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return true;
      throw e;
    },
  );

const make = Command.make(
  "new",
  {
    campaignDir: Argument.String("campaign-dir").pipe(
      Argument.withDescription("The folder to make; it must be missing or empty"),
    ),
    example: Flag.Boolean("example").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Copy the sample campaign: four heroes, the bandits and the map for one fight",
      ),
    ),
  },
  Effect.fn(function* (o) {
    const dir = resolve(o.campaignDir);
    yield* Effect.tryPromise({
      try: async () => {
        if (!(await isFree(dir))) throw new Error("it already has files in it");
        // The log will be every word said at the table: the folder is its owner's alone.
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        if (o.example) {
          // A copy that fails halfway leaves the folder as it found it: empty, for another try.
          await copyTree(EXAMPLE, dir).catch(async (e: unknown) => {
            for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true });
            throw e;
          });
          return;
        }
        await mkdir(join(dir, "heroes"));
        await mkdir(join(dir, "monsters"));
        await mkdir(join(dir, "maps"));
        await writeFile(
          join(dir, "README.md"),
          `# ${basename(dir)}\n\nA supervillain campaign: hero sheets go in heroes/<id>.yaml, monster stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt, and the host keeps the log in events.jsonl.\n`,
        );
      },
      catch: (e) =>
        new CampaignError({ message: `can't make a campaign in ${dir}: ${messageOf(e)}` }),
    });
    yield* Console.log(
      `supervillain: made ${dir}${o.example ? " from the sample campaign" : " with heroes/, monsters/ and maps/"}`,
    );
    yield* Console.log(`host it with: ${SELF} host ${o.campaignDir}`);
  }),
).pipe(
  Command.withDescription(
    "Make a campaign folder: heroes/ and monsters/ for sheets, maps/ for maps, or the sample campaign with --example",
  ),
);

const importMonsters = Command.make(
  "import",
  {
    from: Argument.String("bestiary-json-path").pipe(
      Argument.withDescription(
        "A local copy of Steel Compendium's data-bestiary-json: the folder or one file",
      ),
    ),
    names: Argument.String("names").pipe(
      Argument.variadic(),
      Argument.withDescription("Creatures to import, by name or id; every one when left out"),
    ),
    into: Flag.String("into").pipe(
      Flag.withDescription("The campaign folder; monster files go in its monsters/"),
    ),
    overwrite: Flag.Boolean("overwrite").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace monster files that are already there"),
    ),
  },
  Effect.fn(function* (o) {
    const { importBestiary, importReportText } = yield* Effect.promise(
      () => import("./content/index.ts"),
    );
    const report = yield* importBestiary({
      from: resolve(o.from),
      into: resolve(o.into),
      names: o.names,
      overwrite: o.overwrite,
    });
    for (const line of importReportText(report)) yield* Console.log(line);
    const missed = report.failed.length + report.notFound.length + report.ambiguous.length;
    if (report.imported.length === 0 && missed === 0)
      return yield* new CampaignError({ message: `no creatures found in ${resolve(o.from)}` });
    if (missed > 0)
      return yield* new CampaignError({
        message: `${missed === 1 ? "one creature" : `${missed} creatures`} not imported`,
      });
  }),
).pipe(
  Command.withDescription(
    "Turn Steel Compendium bestiary JSON into monster files in a campaign's monsters/",
  ),
);

const check = Command.make(
  "check",
  {
    campaignDir: Argument.String("campaign-dir").pipe(
      Argument.withDescription("Folder holding events.jsonl"),
    ),
  },
  Effect.fn(function* (o) {
    const path = join(resolve(o.campaignDir), "events.jsonl");
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) => new CheckError({ message: `can't read ${path}: ${messageOf(e)}` }),
    });
    const report = checkLog(path, text);
    for (const warning of report.warnings) yield* Console.error(warning);
    yield* Console.log(report.out.join("\n"));
    if (report.error !== undefined) return yield* new CheckError({ message: report.error });
  }),
).pipe(
  Command.withDescription(
    "Read a campaign log without opening it: summary, skipped events, feed and final state",
  ),
);

Command.make("supervillain").pipe(
  Command.withDescription("A terminal-first virtual tabletop for Draw Steel"),
  Command.withSubcommands([host, make, importMonsters, check, relayCommand]),
  // scripts/build.ts sets the release's version; from source it's the development one.
  Command.run({ version: process.env.SUPERVILLAIN_VERSION ?? "0.0.0" }),
  // Failures we expect (a bad log, a held lock, a busy port) read as one line, not a trace.
  Effect.catchTags({
    CampaignError: fail,
    CheckError: fail,
    ContentReadError: fail,
    HostError: fail,
    LogError: fail,
    SshError: fail,
  }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({
    // Stopping the host with Ctrl-C or SIGTERM is how it's meant to end, not a failure.
    teardown: (exit, onExit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? onExit(0)
        : Runtime.defaultTeardown(exit, onExit),
  }),
);
