#!/usr/bin/env bun
// The one binary: `supervillain …` compiled (scripts/build.ts), `bun supervillain …` from the repo
// root, or this file from anywhere.
//   supervillain host [campaign-dir] [--port 2222] [--bind 127.0.0.1] [--room name] [--headless]
//                     [--relay host:port] [--relay-key SHA256:…] [--relay-player-port 2222]
//                     [--relay-host-key SHA256:…] [--no-lobby]   (a campaign folder: `new` makes one)
//   supervillain new <campaign-dir> [--rules draw-steel|set-world] [--example]
//   supervillain map <crossing|keep> <campaign-dir> [--seed N] [--id map-id]
//   supervillain import <bestiary-json-path> --into <campaign-dir> [names...] [--overwrite]
//   supervillain check <campaign-dir>
//   supervillain relay [--player-port 2222] [--gm-port 7022] [--bind 0.0.0.0] [--dir ~/.supervillain-relay]
//                      [--claim-days 180]
//   supervillain relay forget <room> [--dir …]
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { isFingerprint } from "@supervillain/ssh";
import { CAMPAIGN_FILE, campaignYaml, readCampaignConfig } from "./content/campaignFile.ts";
import { DEFAULT_RULESET, RULESETS } from "./game/table.ts";
import { checkLog } from "./host/check.ts";
import { bindProblem, portProblem, relayCommand } from "./relay/cli.ts";
import {
  joinNote,
  linkAlert,
  parseRelayAddress,
  relayJoinCommand,
  roomSlug,
} from "./host/RelayLink.ts";
import { isReservedRoom, isRoomName } from "./relay/protocol.ts";

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

/** How players reach this host directly, as one command to paste. */
const joinCommand = (room: string, bind: string, port: number) =>
  relayJoinCommand(
    room,
    bind === "0.0.0.0" || bind === "::" ? "<this machine's address>" : bind,
    port,
  );

const host = Command.make(
  "host",
  {
    campaignDir: Argument.String("campaign-dir").pipe(
      Argument.withDescription(
        "The campaign folder, made with `new` (default ./campaign); it holds events.jsonl and the host key",
      ),
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
    lobby: Flag.Boolean("lobby").pipe(
      Flag.withDefault(true),
      Flag.withDescription(
        "List this table in the relay's lobby for players whose key has sat here before; --no-lobby never lists it",
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
    const problem =
      portProblem("--port", o.port) ??
      bindProblem(o.bind) ??
      (relayPlayerPort === undefined
        ? undefined
        : portProblem("--relay-player-port", relayPlayerPort, 1));
    if (problem !== undefined) return yield* new HostError({ message: problem });
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
    if (relayAddress !== undefined && isReservedRoom(room))
      return yield* new HostError({
        message: `the room name ${room} is reserved on a relay, since a bare ssh sends names like it: pick another with --room`,
      });
    // A mistyped folder would open an empty table under a new host key, which players' ssh
    // warns about: only `new` makes a campaign.
    const folder = yield* Effect.tryPromise({
      try: () =>
        stat(dir).catch((e: NodeJS.ErrnoException) =>
          e.code === "ENOENT" ? undefined : Promise.reject(e),
        ),
      catch: (e) =>
        new HostError({ message: `can't open the campaign folder ${dir}: ${messageOf(e)}` }),
    });
    if (folder === undefined)
      return yield* new HostError({
        message: `there's no campaign at ${dir}; make one with: ${SELF} new ${o.campaignDir} (--example for the sample)`,
      });
    if (!folder.isDirectory())
      return yield* new HostError({ message: `${dir} isn't a folder, so it can't be a campaign` });
    // Nor would an empty or unrelated folder, which would silently get a log and a host key.
    const looks = yield* Effect.tryPromise({
      try: () => looksLikeCampaign(dir),
      catch: (e) =>
        new HostError({ message: `can't open the campaign folder ${dir}: ${messageOf(e)}` }),
    });
    if (looks !== true)
      return yield* new HostError({
        message: `${dir} isn't a campaign: it has no ${CAMPAIGN_MARKS.join(", ").replace(/, ([^,]*)$/, " or $1")}; ${
          looks === "empty"
            ? `make one there with: ${SELF} new ${o.campaignDir}`
            : `make one in a new folder with: ${SELF} new <folder>`
        } (--example for the sample)`,
      });
    // The table (OpenTUI and Solid) loads only here, so `check` never needs it. Its JSX needs the
    // Solid transform, which bunfig.toml preloads only when run from the repo root.
    yield* Effect.promise(() => import("../preload.ts"));
    const { tableServices } = yield* Effect.promise(() => import("./host/services.ts"));
    const { TableServer } = yield* Effect.promise(() => import("./host/TableServer.ts"));
    const { localSeat } = yield* Effect.promise(() => import("./host/LocalSeat.ts"));
    const { CampaignContent } = yield* Effect.promise(() => import("./content/index.ts"));

    const layer = TableServer.layer({
      campaignDir: dir,
      room,
      port: o.port,
      bind: o.bind,
      lobby: o.lobby,
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
      const { ruleset } = yield* CampaignContent;
      const relay = server.relay;
      const direct = joinCommand(room, o.bind, server.port);
      const joining = relay?.joinCommand ?? direct;
      // Through a relay, players' ssh meets the relay's host key, never this table's.
      const relayHostKeyText =
        relayHostKey ?? "ask whoever runs the relay (it prints it as its host key)";
      yield* Console.log(`supervillain: hosting "${room}" from ${dir}, playing ${ruleset}`);
      yield* Console.log(`players join with: ${joining}${relay ? " (through the relay)" : ""}`);
      if (relay !== undefined && relayAddress !== undefined) {
        yield* Console.log(`  players' ssh sees the relay's host key: ${relayHostKeyText}`);
        yield* Console.log(`players here can also join directly: ${direct}`);
        yield* Console.log(
          `relay ${relayAddress.host}:${relayAddress.port}, trusting ${relayKey ?? `the key in ${join(dir, "relay_known")} (pinned on first link)`}`,
        );
        yield* Console.log(
          o.lobby
            ? "  its lobby lists this table to players whose key has sat here (--no-lobby: never)"
            : "  its lobby never lists this table (--no-lobby)",
        );
      }
      yield* Console.log(
        `host key ${server.hostKeyFingerprint}${relay ? " (this table's: direct connections only)" : ""}`,
      );
      // host.log carries the same key guidance as stdout and /help: at a seat, it's all there is.
      yield* Effect.logInfo(
        relay
          ? `hosting "${room}" on ${o.bind}:${server.port} (direct: ${direct}); through the relay: ${joining}; players' ssh sees the relay's host key: ${relayHostKeyText}; this table's host key ${server.hostKeyFingerprint} is for direct connections only`
          : `hosting "${room}" on ${o.bind}:${server.port}, players: ${joining}; host key ${server.hostKeyFingerprint}`,
      );
      if (o.headless) return yield* Effect.never;
      const relayJoining =
        relay === undefined
          ? joining
          : `${relay.joinCommand}${relayHostKey === undefined ? "" : ` · relay host key ${relayHostKey}`}`;
      yield* localSeat({
        room,
        helpFooter: relay
          ? `Players join through the relay with: ${joining}\nThe relay's host key, which their ssh sees: ${relayHostKeyText}\nPlayers here can join directly: ${direct} (host key ${server.hostKeyFingerprint})`
          : `Players join with: ${joining}\nHost key: ${server.hostKeyFingerprint}`,
        // The seat covers what was printed, so the band carries the key players check too.
        joinHint: relay ? joining : `${joining} · host key ${server.hostKeyFingerprint}`,
        ...(relay === undefined
          ? {}
          : {
              joinNote: {
                get: Effect.map(relay.status.get, (s) => joinNote(s, relayJoining)),
                changes: Stream.map(relay.status.changes, (s) => joinNote(s, relayJoining)),
              },
              alert: {
                get: Effect.map(relay.status.get, linkAlert),
                changes: Stream.map(relay.status.changes, linkAlert),
              },
            }),
      });
      yield* Effect.logInfo("the GM left the table; shutting down");
    }).pipe(
      Effect.provide(layer),
      Effect.provide(logs),
      Effect.mapError((e) =>
        e._tag === "SshError" && /EADDRINUSE/.test(e.message)
          ? new HostError({
              message: `port ${o.port} on ${o.bind} is in use (another table?); pick another with --port, or --port 0 for any free one`,
            })
          : e,
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Open the table: the campaign log, the SSH server and (unless --headless) the GM's seat",
  ),
);

/** What `new` or a host leaves in a campaign folder: any one of them makes a folder a campaign. */
const CAMPAIGN_MARKS = [
  CAMPAIGN_FILE,
  "events.jsonl",
  "host_key",
  "heroes/",
  "monsters/",
  "maps/",
] as const;

/** Whether `dir` holds any of CAMPAIGN_MARKS; if not, whether it is empty or holds other things. */
const looksLikeCampaign = async (dir: string): Promise<true | "empty" | "unrelated"> => {
  const names = await readdir(dir, { withFileTypes: true });
  const found = CAMPAIGN_MARKS.some((mark) =>
    names.some((d) =>
      mark.endsWith("/") ? d.isDirectory() && `${d.name}/` === mark : d.isFile() && d.name === mark,
    ),
  );
  if (found) return true;
  return names.length === 0 ? "empty" : "unrelated";
};

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
    rules: Flag.Literals("rules", RULESETS).pipe(
      Flag.optional,
      Flag.withDescription(
        "What the campaign plays: draw-steel (the default) or set-world, written to its campaign.yaml",
      ),
    ),
    example: Flag.Boolean("example").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Copy the sample campaign: four heroes, the bandits and the map for one Draw Steel fight",
      ),
    ),
  },
  Effect.fn(function* (o) {
    const dir = resolve(o.campaignDir);
    const rules = Option.getOrElse(o.rules, () => DEFAULT_RULESET);
    if (o.example && rules !== "draw-steel")
      return yield* new CampaignError({
        message: `the sample campaign plays draw-steel, so --example can't make a ${rules} campaign; leave out --example for an empty one`,
      });
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
        await writeFile(join(dir, CAMPAIGN_FILE), campaignYaml(rules));
        if (rules === "draw-steel") {
          await mkdir(join(dir, "heroes"));
          await mkdir(join(dir, "monsters"));
        }
        await mkdir(join(dir, "maps"));
        await writeFile(
          join(dir, "README.md"),
          rules === "draw-steel"
            ? `# ${basename(dir)}\n\nA supervillain campaign playing Draw Steel (campaign.yaml says so): hero sheets go in heroes/<id>.yaml, monster stat blocks in monsters/<id>.yaml, text maps in maps/<id>.txt, and the host keeps the log in events.jsonl.\n`
            : `# ${basename(dir)}\n\nA supervillain campaign playing set.world's rules (campaign.yaml says so): fighters are rolled at set.world at the table, text maps go in maps/<id>.txt, and the host keeps the log in events.jsonl.\n`,
        );
      },
      catch: (e) =>
        new CampaignError({ message: `can't make a campaign in ${dir}: ${messageOf(e)}` }),
    });
    yield* Console.log(
      `supervillain: made ${dir}${o.example ? " from the sample campaign" : rules === "draw-steel" ? " with heroes/, monsters/ and maps/" : ` playing ${rules}, with maps/`}`,
    );
    yield* Console.log(`host it with: ${SELF} host ${o.campaignDir}`);
  }),
).pipe(
  Command.withDescription(
    "Make a campaign folder: its campaign.yaml, heroes/ and monsters/ for sheets, maps/ for maps, or the sample campaign with --example",
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

const mapCommand = Command.make(
  "map",
  {
    kind: Argument.String("kind").pipe(
      Argument.withDescription(
        "What kind of place: crossing (a river, a road, woods, a ruin) or keep",
      ),
    ),
    campaignDir: Argument.String("campaign-dir").pipe(
      Argument.withDescription("The campaign folder; the map goes in its maps/"),
    ),
    seed: Flag.Int("seed").pipe(
      Flag.optional,
      Flag.withDescription(
        "The seed, 0 to 4294967295: the same kind and seed always make the same map",
      ),
    ),
    id: Flag.String("id").pipe(
      Flag.optional,
      Flag.withDescription("The map's id, its file name in maps/ (default: <kind>-<seed>)"),
    ),
  },
  Effect.fn(function* (o) {
    const [{ writeGeneratedMap }, { formatSquare, MAP_KINDS }] = yield* Effect.promise(() =>
      Promise.all([import("./content/newMap.ts"), import("./game/drawSteel/map.ts")]),
    );
    const kind = MAP_KINDS.find((k) => k === o.kind.toLowerCase());
    if (kind === undefined)
      return yield* new CampaignError({
        message: `there's no kind of map called ${o.kind}; there are: ${MAP_KINDS.join(", ")}`,
      });
    const seed = Option.getOrElse(o.seed, () => crypto.getRandomValues(new Uint32Array(1))[0]!);
    const written = yield* writeGeneratedMap(
      resolve(o.campaignDir),
      kind,
      seed,
      Option.getOrUndefined(o.id),
    ).pipe(
      Effect.mapError(
        (e) =>
          new CampaignError({
            message:
              e.reason === "exists"
                ? `${e.message}; pick another --id`
                : e.reason === "no-campaign"
                  ? `${e.message}; make one with: ${SELF} new ${o.campaignDir}`
                  : e.message,
          }),
      ),
    );
    const { id, map } = written;
    yield* Console.log(
      `supervillain: wrote ${map.name} to ${written.file} (${kind}, seed ${written.seed})`,
    );
    yield* Console.log(map.lines.map((line) => `  ${line}`).join("\n"));
    const squares = (list: ReadonlyArray<{ x: number; y: number }>) =>
      list.slice(0, 4).map(formatSquare).join(" ");
    yield* Console.log(
      `the party can start at ${squares(map.deploy.west)}, their foes at ${squares(map.deploy.east)}`,
    );
    yield* Console.log(`load it at the table with: /map ${id}`);
  }),
).pipe(
  Command.withDescription(
    "Generate a battlemap in MEKMODE letters into a campaign's maps/: a river crossing or a keep",
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
    const dir = resolve(o.campaignDir);
    const path = join(dir, "events.jsonl");
    const text = yield* Effect.tryPromise({
      try: () =>
        readFile(path, "utf8").catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          await stat(dir);
          return undefined;
        }),
      catch: (e) =>
        new CheckError({
          message:
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? `there's no campaign at ${dir}`
              : `can't read ${path}: ${messageOf(e)}`,
        }),
    });
    if (text === undefined)
      return yield* Console.log(`${path}: no log yet; the table hasn't been opened`);
    // The feed names players by the hero or fighter they play in the campaign's ruleset.
    const { rules } = yield* readCampaignConfig(dir).pipe(
      Effect.mapError((e) => new CheckError({ message: e.message })),
    );
    const report = checkLog(path, text, rules);
    for (const warning of report.warnings) yield* Console.error(warning);
    yield* Console.log(report.out.join("\n"));
    if (report.error !== undefined) return yield* new CheckError({ message: report.error });
  }),
).pipe(
  Command.withDescription(
    "Read a campaign log without opening it: summary, skipped events, feed and final state",
  ),
);

// A hang-up (the terminal's window closed, the ssh to this machine dropped) ends the host or the
// relay as SIGTERM does, through the runtime below: players are told and every finalizer runs.
// Only at a terminal: under nohup there is none, and the hang-up stays ignored.
if (process.stdin.isTTY) process.on("SIGHUP", () => process.kill(process.pid, "SIGTERM"));

Command.make("supervillain").pipe(
  Command.withDescription("A terminal-first virtual tabletop for Draw Steel, or set.world's rules"),
  Command.withSubcommands([host, make, mapCommand, importMonsters, check, relayCommand]),
  // scripts/build.ts sets the release's version; from source it's the development one.
  Command.run({ version: process.env.SUPERVILLAIN_VERSION ?? "0.0.0" }),
  // Failures we expect (a bad log, a held lock, a busy port) read as one line, not a trace.
  Effect.catchTags({
    CampaignConfigInvalid: fail,
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
