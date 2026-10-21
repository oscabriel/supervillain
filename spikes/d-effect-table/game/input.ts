import { chat, commands } from "./commands.ts"
import type { Command } from "./rules.ts"
import type { RoomState } from "./state.ts"

export type Parsed =
  | { kind: "command"; command: Command }
  | { kind: "refusal"; message: string }
  | { kind: "help"; text: string }
  | { kind: "state" }

/** Everything the input line knows: the registry's commands plus the two surface-only entries. */
interface Entry {
  name: string
  usage: string
  summary: string
  gmOnly: boolean
  run(args: string): Parsed
  complete?(state: RoomState, partial: string): string[]
}

const fromSpec = (args: string, parse: (a: string) => Command | { refusal: string }): Parsed => {
  const r = parse(args)
  return "refusal" in r ? { kind: "refusal", message: r.refusal } : { kind: "command", command: r }
}

const entries: Entry[] = [
  ...commands.map(
    (spec): Entry => ({
      name: spec.name,
      usage: spec.usage,
      summary: spec.summary,
      gmOnly: spec.gmOnly,
      run: (args) => fromSpec(args, spec.parse),
      complete: spec.complete,
    }),
  ),
  {
    name: "help",
    usage: "/help [command]",
    summary: "List commands, or explain one.",
    gmOnly: false,
    run: (args) => help(args.trim()),
    complete: (_state, partial) => entries.map((e) => e.name).filter((n) => n.startsWith(partial.trim())),
  },
  {
    name: "state",
    usage: "/state",
    summary: "Toggle the debug pane (room state and recent events).",
    gmOnly: false,
    run: () => ({ kind: "state" }),
  },
]

function lookup(name: string): Entry | { refusal: string } {
  const exact = entries.find((e) => e.name === name)
  if (exact) return exact
  const matches = entries.filter((e) => e.name.startsWith(name))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return { refusal: `'/${name}' could be ${matches.map((e) => `/${e.name}`).join(" or ")}.` }
  return { refusal: `Unknown command '/${name}'. Try /help.` }
}

function helpLine(e: Entry, width: number): string {
  return `${e.usage.padEnd(width)}  ${e.summary}${e.gmOnly ? " (GM)" : ""}`
}

function help(topic: string): Parsed {
  if (topic !== "") {
    const e = lookup(topic.replace(/^\//, ""))
    if ("refusal" in e) return { kind: "refusal", message: e.refusal }
    return { kind: "help", text: helpLine(e, e.usage.length) }
  }
  const width = Math.max(...entries.map((e) => e.usage.length))
  const lines = entries.map((e) => helpLine(e, width))
  return { kind: "help", text: ["Plain text is chat. Tab completes, Up/Down is history.", ...lines].join("\n") }
}

function splitCommand(line: string): { name: string; args: string; hasArgs: boolean } {
  const body = line.trimStart().slice(1)
  const space = body.search(/\s/)
  if (space === -1) return { name: body, args: "", hasArgs: false }
  return { name: body.slice(0, space), args: body.slice(space + 1), hasArgs: true }
}

/** Plain text is chat; "/x ..." looks x up in the registry (exact name, then unique prefix). */
export function parseInputLine(line: string): Parsed {
  const trimmed = line.trim()
  if (trimmed === "") return { kind: "refusal", message: "Type something, or /help." }
  if (!trimmed.startsWith("/")) return fromSpec(trimmed, chat.parse)
  const { name, args } = splitCommand(trimmed)
  if (name === "") return help("")
  const entry = lookup(name.toLowerCase())
  if ("refusal" in entry) return { kind: "refusal", message: entry.refusal }
  return entry.run(args)
}

/** Candidate full lines to replace the input with. Empty when there is nothing to complete. */
export function completeLine(state: RoomState, line: string): string[] {
  if (!line.trimStart().startsWith("/")) return []
  const { name, args, hasArgs } = splitCommand(line)
  if (!hasArgs) {
    return entries.filter((e) => e.name.startsWith(name.toLowerCase())).map((e) => `/${e.name} `)
  }
  const entry = lookup(name.toLowerCase())
  if ("refusal" in entry || !entry.complete) return []
  return entry.complete(state, args).map((arg) => `/${entry.name} ${arg} `)
}

export function helpText(): string {
  const h = help("")
  return h.kind === "help" ? h.text : ""
}
