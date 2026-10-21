# Spike D contract (PROTOTYPE, throwaway)

The question: does "Effect at the host edge, pure rules, SSH all the way down, one command contract for every surface" hold up as a runnable table? Everything here is throwaway. No tests, minimal error handling, but it must run.

Pinned: `effect@4.0.5`, `@effect/platform-bun@4.0.5`, `@opentui/{core,solid,ssh}@0.6.6`, `solid-js@1.9.12`, `ssh2@1.16.0`, Bun 1.4.2. Deps are installed; do not add or change dependencies. Effect's own agent guide ships at `node_modules/effect/AGENTS.md`. Effect source: `~/Developer/clones/github.com/Effect-TS/effect`. OpenTUI source: `~/Developer/clones/github.com/anomalyco/opentui`, read v0.6.6 with `git -C <clone> show v0.6.6:<path>` (do not change that clone's checkout). In Effect 4.0.5 the former `effect/unstable/*` modules are at `effect/<area>` (e.g. `effect/cli`).

## Layout and ownership

```
game/      PURE. May import `effect/Schema` for data definitions. No Effect runtime, no I/O, no Date, no Math.random.
  events.ts    Envelope type and event payload schemas
  state.ts     RoomState and the initial state
  rules.ts     decide() and apply()
  commands.ts  the CommandSpec registry: one entry per command
  input.ts     input-line parsing, tab completion, help text, all derived from commands.ts
host/      Effect services (Context.Service + Layer)
  CampaignLog.ts   the JSONL file
  Room.ts          the single writer
  TableServer.ts   @opentui/ssh server, one Scope per session
  LocalSeat.ts     the GM's own terminal, same App
table/     OpenTUI + Solid
  App.tsx          the one layout
relay/
  relay.ts         SSH-in-SSH relay (hypothesis test)
cli.ts     effect/cli entry: host, relay, check (only host loads the table)
```

## Shared types (game/)

```ts
// game/events.ts
export interface Envelope { actor: string; seq: number; timestamp: string; type: string; payload: unknown }
// event types and payloads:
//   "chat.posted"      { text: string }
//   "dice.rolled"      { notation: string; rolls: number[]; modifier: number; total: number }
//   "name.set"         { name: string }                  // display name for envelope.actor
//   "creature.added"   { id: string; name: string; stamina: number }   // id is a slug, unique
//   "stamina.changed"  { id: string; delta: number; reason: "damage" | "heal" }

// game/state.ts
export interface Creature { id: string; name: string; stamina: number; max: number }
export interface FeedEntry { seq: number; actor: string; kind: EventType; text: string }   // rendered line, names resolved at apply time; the table styles by kind, never by text
export interface RoomState { seq: number; names: Record<string, string>; creatures: Creature[]; feed: FeedEntry[] }
export const initialState: RoomState

// game/rules.ts
export type Dice = (sides: number) => number   // host supplies it; rules never roll on their own
export type Command =
  | { type: "chat"; text: string }
  | { type: "roll"; notation: string }
  | { type: "name"; name: string }
  | { type: "add"; name: string; stamina: number }     // GM only
  | { type: "dmg"; target: string; amount: number }    // GM: anyone; others: refused in this spike
  | { type: "heal"; target: string; amount: number }
export type Decision = { events: Array<{ type: string; payload: unknown }> } | { refusal: string }
export function decide(state: RoomState, actor: string, command: Command, dice: Dice): Decision
export function apply(state: RoomState, envelope: Envelope): RoomState   // pure; throws on an event it can't apply
export function isGmOnly(type: Command["type"]): boolean   // the one GM-only table; decide enforces it, the registry shows it
// name: refused if another actor already answers to it (their name or default label, incl. "GM"), case-insensitively

// game/events.ts also holds the one log reader, used by the host's replay and by `check`:
export function parseLog(text: string): { envelopes: Envelope[]; intact: string; torn?: string; error?: { line: number; message: string } }

// game/commands.ts — ONE contract per command, projected to every surface
export interface CommandSpec {
  name: Command["type"]        // "roll"; the registry is a Record<Command["type"], ...> so a missing or extra command fails to compile
  usage: string                // "/roll <dice>"  e.g. 2d10+3
  summary: string
  gmOnly: boolean              // derived from isGmOnly
  parse(args: string): Command | { refusal: string }
  complete?(state: RoomState, partial: string): string[]   // argument completion (creature names etc.)
}
export const commands: CommandSpec[]
export const chat: CommandSpec   // plain text goes here

// game/input.ts
export type Parsed = { kind: "command"; command: Command } | { kind: "refusal"; message: string } | { kind: "help"; text: string } | { kind: "state" }
export function parseInputLine(line: string): Parsed   // plain text → chat command; "/x ..." → spec lookup; "/help"; "/state"
export function completeLine(state: RoomState, line: string): string[]
```

Targets resolve by exact creature id or name first, then a unique prefix; an ambiguous prefix is refused with the candidates ("'gob' could be Goblin or Goblin Archer").

## Actors

- An SSH session's actor is `key:<SHA256 fingerprint>` of the player's verified public key.
- The GM's local seat is actor `gm`. Only `gm` may use gmOnly commands (decide refuses others).
- Feed lines label an actor by display name (from `name.set`), else the first 8 chars of the fingerprint.

## Host services (host/)

```ts
// CampaignLog: Context.Service<CampaignLog, {
//   replay: Effect<Envelope[], LogError>       // on open: cut a half-written last line back to the last newline; a bad middle line fails with its line number
//   append: (envs: Envelope[]) => Effect<void, LogError>   // one write, then fsync
// }>  layer(campaignDir) writes <campaignDir>/events.jsonl, folder named "PROTOTYPE-wipe-me-*" by default
//      and holds <campaignDir>/events.lock (owner pid) for its lifetime: one host per campaign
//
// Room: Context.Service<Room, {
//   submit: (actor: string, command: Command) => Effect<Envelope[], Refusal>
//   state: View<RoomState>          // read-only { get: Effect<A>; changes: Stream<A> }; only submit writes
//   recent: View<Envelope[]>        // last few envelopes, for /state
// }>
// submit is serialized by a Semaphore(1): decide (dice from Effect's Random) → apply to a copy (compute next state BEFORE writing) → CampaignLog.append → SubscriptionRef.set
// If decide/apply throws, nothing is written and state is unchanged; the error is reported as a Refusal.
// On start: replay the log through apply. Replay never calls decide and never rolls.
```

## Table (table/App.tsx)

```ts
export interface RoomView {
  state: () => RoomState                              // Solid accessor fed from Room.state changes, batched ~16ms
  submit: (line: string) => Promise<string | undefined>   // returns a refusal message, if any
  complete: (line: string) => string[]
}
export function App(props: { view: RoomView; actor: string }): JSX.Element
```

One layout designed at 100×30, fitting 80×24: header (who is here), roster with Stamina meters (`Goblin ▐████▌ 9/15`), feed, a hint row, and the input line. The input line always owns the keyboard: plain text is chat, `/` is a command, Tab completes, Up/Down is history, PgUp/PgDn scroll the feed. `/state` toggles a debug pane showing the full RoomState JSON and the last few envelopes (prototype rule: surface the state).

## Relay (relay/relay.ts)

Hypothesis: the GM dials out to the relay over TCP; on that one socket the GM is the SSH **server** (ssh2 `Server#injectSocket`) and the relay is the SSH **client**. A player runs `ssh -p <relayPort> <room>@<relayHost>`; the relay terminates that SSH, learns room + key fingerprint, opens a `session` channel on the room's GM connection with `pty-req`, `env SV_ACTOR=key:<fp>`, `shell`, forwards `window-change`, and pipes bytes both ways. The GM trusts `SV_ACTOR` only on connections authenticated with the relay's key, and only if it is a player key (`key:SHA256:<43 base64 chars>`), so the relay can never seat `gm`. The relay's fingerprint is set before the GM's SSH server reads a byte of the link. `@opentui/ssh` 0.6.6 does not expose `injectSocket`; find the least invasive way (its internals, a small wrapper, or a raw ssh2 Server path that still hands a session to the same table handler) and report what it took.
