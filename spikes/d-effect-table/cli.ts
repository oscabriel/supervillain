// Spike D entry (PROTOTYPE). Run `host` from this folder so bunfig.toml loads the Solid JSX transform;
// `relay` and `check` never load the table, so they run from anywhere.
//   bun cli.ts host <campaign-dir> [--port 2222] [--relay host:port --room name] [--headless]
//   bun cli.ts relay [--player-port 2200] [--gm-port 7000]
//   bun cli.ts check <campaign-dir>
import { mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Logger, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { isEventType, parseLog } from "./game/events.ts"
import { apply } from "./game/rules.ts"
import { actorLabel, initialState, type RoomState } from "./game/state.ts"
import { CampaignLog, LogError } from "./host/CampaignLog.ts"
import { Room } from "./host/Room.ts"
import { startRelay } from "./relay/relay.ts"

const DEFAULT_CAMPAIGN = "PROTOTYPE-wipe-me-campaign"

const campaignDir = Argument.String("campaign-dir").pipe(
  Argument.withDescription(`Folder holding events.jsonl and the host key (default ./${DEFAULT_CAMPAIGN})`),
  Argument.withDefault(DEFAULT_CAMPAIGN),
)

const host = Command.make(
  "host",
  {
    campaignDir,
    port: Flag.Int("port").pipe(Flag.withDefault(2222), Flag.withDescription("SSH port for players")),
    bind: Flag.String("bind").pipe(Flag.withDefault("127.0.0.1"), Flag.withDescription("Address to listen on")),
    relay: Flag.String("relay").pipe(Flag.optional, Flag.withDescription("Dial out to a relay's GM port, host:port")),
    room: Flag.String("room").pipe(Flag.withDefault("table"), Flag.withDescription("Room name at the relay")),
    headless: Flag.Boolean("headless").pipe(Flag.withDefault(false), Flag.withDescription("No local GM seat")),
  },
  Effect.fn(function* (o) {
    // The table (OpenTUI + Solid) loads only here, so relay and check don't depend on it.
    const { localSeat } = yield* Effect.promise(() => import("./host/LocalSeat.ts"))
    const { Presence } = yield* Effect.promise(() => import("./host/Seat.ts"))
    const { TableServer } = yield* Effect.promise(() => import("./host/TableServer.ts"))
    let relay: { host: string; port: number; room: string } | undefined
    if (Option.isSome(o.relay)) {
      const [h, p] = o.relay.value.split(":")
      relay = { host: h || "127.0.0.1", port: Number(p ?? 7000), room: o.room }
    }
    const layer = TableServer.layer({ campaignDir: o.campaignDir, port: o.port, bind: o.bind, relay }).pipe(
      Layer.provideMerge(Presence.layer),
      Layer.provideMerge(Room.layer),
      Layer.provideMerge(CampaignLog.layer(o.campaignDir)),
    )
    // The GM's seat owns this terminal, so logs go to a file beside the campaign log.
    mkdirSync(o.campaignDir, { recursive: true })
    const logs = o.headless
      ? Layer.empty
      : Logger.layer([Logger.toFile(Logger.formatSimple, join(o.campaignDir, "host.log"), { flag: "a" })])
    yield* Effect.gen(function* () {
      yield* TableServer
      if (o.headless) return yield* Effect.never
      yield* localSeat
      yield* Effect.logInfo("GM left the table; shutting down")
    }).pipe(Effect.provide(layer), Effect.provide(logs))
  }),
).pipe(Command.withDescription("Open the table: SSH server, the log, and (unless --headless) the GM's seat"))

const relay = Command.make(
  "relay",
  {
    playerPort: Flag.Int("player-port").pipe(Flag.withDefault(2200)),
    gmPort: Flag.Int("gm-port").pipe(Flag.withDefault(7000)),
    bind: Flag.String("bind").pipe(Flag.withDefault("127.0.0.1")),
    keys: Flag.String("keys").pipe(Flag.withDefault("PROTOTYPE-wipe-me-relay-keys")),
  },
  Effect.fn(function* (o) {
    yield* startRelay({
      playerPort: o.playerPort,
      gmPort: o.gmPort,
      host: o.bind,
      hostKeyPath: join(o.keys, "host_key"),
      relayKeyPath: join(o.keys, "relay_key"),
    })
    return yield* Effect.never
  }, Effect.scoped),
).pipe(Command.withDescription("Run the SSH-in-SSH relay: players ssh <room>@relay, GMs dial in"))

// The reader view: read-only, the same parseLog as the host, folds with apply, skips unknown events loudly.
const check = Command.make(
  "check",
  { campaignDir },
  Effect.fn(function* (o) {
    const path = join(o.campaignDir, "events.jsonl")
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) => new LogError({ message: `read ${path}: ${e instanceof Error ? e.message : String(e)}` }),
    })
    const parsed = parseLog(text)
    if (parsed.torn !== undefined) yield* Console.warn(`last line has no newline (torn write?); ignoring it`)
    let state: RoomState = initialState
    const types = new Map<string, number>()
    const actors = new Set<string>()
    let skipped = 0
    for (const [i, env] of parsed.envelopes.entries()) {
      if (!isEventType(env.type)) {
        yield* Console.warn(`line ${i + 1}: skipping unknown event type "${env.type}"`)
        skipped++
        continue
      }
      const before = state
      state = yield* Effect.try({
        try: () => apply(before, env),
        catch: (e) => new LogError({ message: `${path}:${i + 1}: ${e instanceof Error ? e.message : String(e)}`, line: i + 1 }),
      })
      types.set(env.type, (types.get(env.type) ?? 0) + 1)
      actors.add(env.actor)
    }
    if (parsed.error) {
      const { line, message } = parsed.error
      return yield* new LogError({ message: `${path}:${line}: ${message} (read ${parsed.envelopes.length} lines before it)`, line })
    }
    yield* Console.log(`${path}: ${parsed.envelopes.length} lines, seq ${state.seq}, ${skipped} skipped`)
    yield* Console.log(`events: ${[...types].map(([t, n]) => `${t}×${n}`).join(", ") || "none"}`)
    yield* Console.log(`actors: ${[...actors].map((a) => `${actorLabel(state, a)} (${a})`).join(", ") || "none"}`)
    yield* Console.log(`\nfeed:`)
    for (const f of state.feed) yield* Console.log(`  ${String(f.seq).padStart(4)}  ${f.text}`)
    yield* Console.log(`\nstate:`)
    yield* Console.log(JSON.stringify({ ...state, feed: `[${state.feed.length} entries]` }, null, 2))
  }),
).pipe(Command.withDescription("Replay a campaign log read-only and print the summary and final state"))

Command.make("supervillain-spike-d").pipe(
  Command.withDescription("Spike D (PROTOTYPE): Effect host, pure rules, SSH table"),
  Command.withSubcommands([host, relay, check]),
  Command.run({ version: "0.0.0-prototype" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
