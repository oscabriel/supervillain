import { type Command, isGmOnly, parseNotation } from "./rules.ts"
import type { RoomState } from "./state.ts"

/** One contract per command, projected to every surface (input line, completion, help). */
export interface CommandSpec {
  name: Command["type"]
  usage: string
  summary: string
  gmOnly: boolean // derived from rules.isGmOnly, which decide enforces
  parse(args: string): Command | { refusal: string }
  complete?(state: RoomState, partial: string): string[]
}

type SpecBody = Omit<CommandSpec, "name" | "gmOnly">

/** Splits "Goblin Archer 3" into ["Goblin Archer", 3]: the last word is the number. */
function splitTrailingNumber(args: string, usage: string): [string, number] | { refusal: string } {
  const m = /^(.*\S)\s+(-?\d+)$/.exec(args.trim())
  if (!m) return { refusal: `Usage: ${usage}` }
  return [m[1]!, Number(m[2])]
}

function completeCreature(state: RoomState, partial: string): string[] {
  const q = partial.trimStart().toLowerCase()
  const names = state.creatures
    .filter((c) => c.name.toLowerCase().startsWith(q) || c.id.startsWith(q))
    .map((c) => c.name)
  return [...new Set(names)]
}

function staminaCommand(type: "dmg" | "heal", summary: string): SpecBody {
  const usage = `/${type} <creature> <amount>`
  return {
    usage,
    summary,
    parse(args) {
      const split = splitTrailingNumber(args, usage)
      if ("refusal" in split) return split
      const [target, amount] = split
      if (amount <= 0) return { refusal: "Amount must be above 0." }
      return { type, target, amount }
    },
    complete: completeCreature,
  }
}

const specs = {
  chat: {
    usage: "/chat <text>",
    summary: "Say something to the table (plain text does the same).",
    parse: (args) => (args.trim() === "" ? { refusal: "Say something." } : { type: "chat", text: args.trim() }),
  },
  roll: {
    usage: "/roll <dice>",
    summary: "Roll dice, e.g. 2d10+3 or d6.",
    parse(args) {
      if (args.trim() === "") return { refusal: "Usage: /roll <dice>, e.g. 2d10+3" }
      const n = parseNotation(args)
      return "refusal" in n ? n : { type: "roll", notation: n.text }
    },
    complete: (_state, partial) => ["2d10", "2d10+2", "d3", "d6", "d10"].filter((d) => d.startsWith(partial.trim())),
  },
  name: {
    usage: "/name <display name>",
    summary: "Set the name others see for you.",
    parse: (args) => (args.trim() === "" ? { refusal: "Usage: /name <display name>" } : { type: "name", name: args.trim() }),
  },
  add: {
    usage: "/add <name> <stamina>",
    summary: "Add a creature to the roster.",
    parse(args) {
      const split = splitTrailingNumber(args, "/add <name> <stamina>")
      if ("refusal" in split) return split
      const [name, stamina] = split
      if (stamina <= 0) return { refusal: "Stamina must be above 0." }
      return { type: "add", name, stamina }
    },
  },
  dmg: staminaCommand("dmg", "Deal damage to a creature."),
  heal: staminaCommand("heal", "Restore a creature's Stamina, up to its max."),
} satisfies Record<Command["type"], SpecBody>

const toSpec = (name: Command["type"]): CommandSpec => ({ name, gmOnly: isGmOnly(name), ...specs[name] })

export const commands: CommandSpec[] = (Object.keys(specs) as Command["type"][]).map(toSpec)

/** Plain text goes straight to chat. */
export const chat: CommandSpec = toSpec("chat")
