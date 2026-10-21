#!/usr/bin/env bun
// The one binary: `bun supervillain …` from the repo root, or this file from anywhere.
//   supervillain host [campaign-dir] [--port 2222] [--bind 127.0.0.1] [--room name] [--headless]
//   supervillain new <campaign-dir> [--example]
//   supervillain import <bestiary-json-path> --into <campaign-dir> [names...] [--overwrite]
//   supervillain check <campaign-dir>
import { chmod, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Logger, Option, Runtime, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { checkLog } from "./host/check.ts";

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

/** The sample campaign `new --example` copies. */
const EXAMPLE = join(import.meta.dir, "../../../examples/campaign");

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
      Flag.withDescription("The room's name (default: the campaign folder's name)"),
    ),
    headless: Flag.Boolean("headless").pipe(
      Flag.withDefault(false),
      Flag.withDescription("No GM seat in this terminal; logs go to stdout"),
    ),
  },
  Effect.fn(function* (o) {
    const dir = resolve(o.campaignDir);
    const room = Option.getOrElse(o.room, () => basename(dir));
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

    const layer = TableServer.layer({ campaignDir: dir, room, port: o.port, bind: o.bind }).pipe(
      Layer.provideMerge(tableServices(dir)),
    );
    // The GM's seat owns this terminal, and log lines would tear its frame: they go to a file.
    const logs = o.headless
      ? Layer.empty
      : Logger.layer([
          Logger.toFile(Logger.formatSimple, join(dir, "host.log"), { flag: "a", mode: 0o600 }),
        ]);

    yield* Effect.gen(function* () {
      const server = yield* TableServer;
      const joining = joinCommand(room, o.bind, server.port);
      yield* Console.log(`supervillain: hosting "${room}" from ${dir}`);
      yield* Console.log(`players join with: ${joining}`);
      yield* Console.log(`host key ${server.hostKeyFingerprint}`);
      yield* Effect.logInfo(`hosting "${room}" on ${o.bind}:${server.port}, players: ${joining}`);
      if (o.headless) return yield* Effect.never;
      yield* localSeat({
        room,
        helpFooter: `Players join with: ${joining}\nHost key: ${server.hostKeyFingerprint}`,
        joinHint: joining,
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
      Flag.withDescription("Copy the sample campaign: four heroes and the bandits for one fight"),
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
          await cp(EXAMPLE, dir, { recursive: true });
          return;
        }
        await mkdir(join(dir, "heroes"));
        await mkdir(join(dir, "monsters"));
        await writeFile(
          join(dir, "README.md"),
          `# ${basename(dir)}\n\nA supervillain campaign: hero sheets go in heroes/<id>.yaml, monster stat blocks in monsters/<id>.yaml, and the host keeps the log in events.jsonl.\n`,
        );
      },
      catch: (e) =>
        new CampaignError({ message: `can't make a campaign in ${dir}: ${messageOf(e)}` }),
    });
    yield* Console.log(
      `supervillain: made ${dir}${o.example ? " from the sample campaign" : " with heroes/ and monsters/"}`,
    );
    yield* Console.log(`host it with: bun supervillain host ${o.campaignDir}`);
  }),
).pipe(
  Command.withDescription(
    "Make a campaign folder: heroes/ and monsters/ for sheets, or the sample campaign with --example",
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
  Command.withSubcommands([host, make, importMonsters, check]),
  Command.run({ version: "0.0.0" }),
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
