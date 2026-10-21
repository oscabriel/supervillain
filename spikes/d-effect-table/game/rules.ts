import * as Schema from "effect/Schema"
import { type Envelope, event, eventSchemas, isEventType } from "./events.ts"
import { type Creature, FEED_LIMIT, type RoomState, actorLabel, defaultLabel } from "./state.ts"

/** The host supplies dice; rules never roll on their own. Returns 1..sides. */
export type Dice = (sides: number) => number

export type Command =
  | { type: "chat"; text: string }
  | { type: "roll"; notation: string }
  | { type: "name"; name: string }
  | { type: "add"; name: string; stamina: number }
  | { type: "dmg"; target: string; amount: number }
  | { type: "heal"; target: string; amount: number }

export type Decision = { events: Array<{ type: string; payload: unknown }> } | { refusal: string }

export const GM = "gm"
export const NAME_MAX = 24
const refuse = (refusal: string): Decision => ({ refusal })

/** The one place GM-only lives: decide enforces it, the command registry shows it. */
const GM_ONLY: Partial<Record<Command["type"], string>> = {
  add: "add creatures",
  dmg: "deal damage",
  heal: "heal",
}
export const isGmOnly = (type: Command["type"]): boolean => type in GM_ONLY

/** Labels other actors answer to (their name and their default label); a new name may not collide. */
function takenLabels(state: RoomState, actor: string): Set<string> {
  const others = new Set([GM, ...Object.keys(state.names), ...state.feed.map((f) => f.actor)])
  others.delete(actor)
  return new Set([...others].flatMap((a) => [actorLabel(state, a), defaultLabel(a)].map((l) => l.toLowerCase())))
}

// ---- dice notation -------------------------------------------------------

export interface Notation {
  count: number
  sides: number
  modifier: number
  text: string // normalized, e.g. "2d10+3"
}

/** NdS with an optional +/-modifier; "d6" means 1d6. N <= 100, S <= 1000. */
export function parseNotation(input: string): Notation | { refusal: string } {
  const compact = input.replace(/\s+/g, "").toLowerCase()
  const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(compact)
  if (!m) return { refusal: `'${input}' is not dice notation; try 2d10+3 or d6.` }
  const count = m[1] === "" ? 1 : Number(m[1])
  const sides = Number(m[2])
  const modifier = m[3] ? Number(m[3]) : 0
  if (count < 1 || count > 100) return { refusal: "Roll between 1 and 100 dice." }
  if (sides < 1 || sides > 1000) return { refusal: "Dice need between 1 and 1000 sides." }
  if (Math.abs(modifier) > 1000) return { refusal: "Keep the modifier within 1000." }
  const mod = modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : `${modifier}`
  return { count, sides, modifier, text: `${count}d${sides}${mod}` }
}

// ---- targets -------------------------------------------------------------

/** Exact id or name first, then a unique prefix of either; ambiguity is refused with the candidates. */
export function resolveTarget(state: RoomState, query: string): Creature | { refusal: string } {
  const q = query.trim().toLowerCase()
  if (q === "") return { refusal: "Name a creature." }
  const byId = state.creatures.find((c) => c.id === q)
  if (byId) return byId
  const byName = state.creatures.filter((c) => c.name.toLowerCase() === q)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) return { refusal: `'${query}' could be ${orList(byName.map((c) => c.id))}.` }
  const byPrefix = state.creatures.filter((c) => c.id.startsWith(q) || c.name.toLowerCase().startsWith(q))
  if (byPrefix.length === 1) return byPrefix[0]!
  if (byPrefix.length > 1) return { refusal: `'${query}' could be ${orList(byPrefix.map((c) => c.name))}.` }
  return { refusal: `No creature matches '${query}'.` }
}

function orList(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "creature"
}

/** A second "Goblin" becomes "Goblin 2" (id goblin-2), so names stay targetable. */
function uniqueCreature(state: RoomState, name: string): { id: string; name: string } {
  const taken = (n: string) => state.creatures.some((c) => c.id === slugify(n) || c.name.toLowerCase() === n.toLowerCase())
  let candidate = name
  for (let n = 2; taken(candidate); n++) candidate = `${name} ${n}`
  return { id: slugify(candidate), name: candidate }
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0

// ---- decide --------------------------------------------------------------

export function decide(state: RoomState, actor: string, command: Command, dice: Dice): Decision {
  const gmOnly = GM_ONLY[command.type]
  if (gmOnly && actor !== GM) return refuse(`Only the GM can ${gmOnly} in this spike.`)
  switch (command.type) {
    case "chat": {
      const text = command.text.trim()
      if (text === "") return refuse("Say something.")
      return { events: [event("chat.posted", { text })] }
    }
    case "roll": {
      const n = parseNotation(command.notation)
      if ("refusal" in n) return n
      const rolls = Array.from({ length: n.count }, () => dice(n.sides))
      if (rolls.some((r) => !Number.isInteger(r) || r < 1 || r > n.sides)) {
        throw new Error(`Dice returned a value outside 1..${n.sides}: ${rolls.join(", ")}`)
      }
      const total = rolls.reduce((a, b) => a + b, 0) + n.modifier
      return { events: [event("dice.rolled", { notation: n.text, rolls, modifier: n.modifier, total })] }
    }
    case "name": {
      const name = command.name.trim()
      if (name === "") return refuse("Pick a name.")
      if (name.length > NAME_MAX) return refuse(`Keep names to ${NAME_MAX} characters.`)
      if (takenLabels(state, actor).has(name.toLowerCase())) return refuse(`'${name}' is taken; pick another name.`)
      return { events: [event("name.set", { name })] }
    }
    case "add": {
      const name = command.name.trim()
      if (name === "") return refuse("Name the creature.")
      if (!isPositiveInt(command.stamina)) return refuse("Stamina must be a whole number above 0.")
      return { events: [event("creature.added", { ...uniqueCreature(state, name), stamina: command.stamina })] }
    }
    case "dmg":
    case "heal": {
      if (!isPositiveInt(command.amount)) return refuse("Amount must be a whole number above 0.")
      const target = resolveTarget(state, command.target)
      if ("refusal" in target) return target
      if (command.type === "dmg") {
        return { events: [event("stamina.changed", { id: target.id, delta: -command.amount, reason: "damage" })] }
      }
      const delta = Math.min(command.amount, target.max - target.stamina)
      if (delta <= 0) return refuse(`${target.name} is already at full Stamina.`)
      return { events: [event("stamina.changed", { id: target.id, delta, reason: "heal" })] }
    }
  }
}

// ---- apply ---------------------------------------------------------------

export function apply(state: RoomState, envelope: Envelope): RoomState {
  const where = `seq ${envelope.seq} (${envelope.type})`
  if (!Number.isInteger(envelope.seq) || envelope.seq <= state.seq) {
    throw new Error(`Cannot apply ${where}: seq must be above ${state.seq}.`)
  }
  if (!isEventType(envelope.type)) throw new Error(`Cannot apply ${where}: unknown event type.`)
  const kind = envelope.type

  const who = actorLabel(state, envelope.actor)
  const next = (patch: Partial<RoomState>, line: string): RoomState => ({
    ...state,
    ...patch,
    seq: envelope.seq,
    feed: [...state.feed, { seq: envelope.seq, actor: envelope.actor, kind, text: line }].slice(-FEED_LIMIT),
  })
  const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S): S["Type"] => {
    try {
      return Schema.decodeUnknownSync(schema)(envelope.payload)
    } catch (e) {
      throw new Error(`Cannot apply ${where}: bad payload: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  switch (envelope.type) {
    case "chat.posted": {
      const p = decode(eventSchemas["chat.posted"])
      return next({}, `${who}: ${p.text}`)
    }
    case "dice.rolled": {
      const p = decode(eventSchemas["dice.rolled"])
      const sum = p.rolls.reduce((a, b) => a + b, 0) + p.modifier
      if (sum !== p.total) throw new Error(`Cannot apply ${where}: total ${p.total} does not match the rolls.`)
      const mod = p.modifier === 0 ? "" : p.modifier > 0 ? ` +${p.modifier}` : ` ${p.modifier}`
      return next({}, `${who} rolled ${p.notation}: [${p.rolls.join(", ")}]${mod} = ${p.total}`)
    }
    case "name.set": {
      const p = decode(eventSchemas["name.set"])
      if (p.name.trim() === "") throw new Error(`Cannot apply ${where}: empty name.`)
      return next({ names: { ...state.names, [envelope.actor]: p.name } }, `${who} is now ${p.name}`)
    }
    case "creature.added": {
      const p = decode(eventSchemas["creature.added"])
      if (state.creatures.some((c) => c.id === p.id)) throw new Error(`Cannot apply ${where}: id '${p.id}' exists.`)
      if (p.stamina <= 0) throw new Error(`Cannot apply ${where}: stamina must be above 0.`)
      const creature: Creature = { id: p.id, name: p.name, stamina: p.stamina, max: p.stamina }
      return next({ creatures: [...state.creatures, creature] }, `${who} added ${p.name} (${p.stamina} Stamina)`)
    }
    case "stamina.changed": {
      const p = decode(eventSchemas["stamina.changed"])
      const target = state.creatures.find((c) => c.id === p.id)
      if (!target) throw new Error(`Cannot apply ${where}: no creature '${p.id}'.`)
      const stamina = target.stamina + p.delta
      const creatures = state.creatures.map((c) => (c.id === p.id ? { ...c, stamina } : c))
      const verb = p.reason === "damage" ? `takes ${-p.delta} damage` : `heals ${p.delta}`
      return next({ creatures }, `${target.name} ${verb} (${target.stamina} → ${stamina}/${target.max})`)
    }
  }
}

/** Fold envelopes from the initial state; replay never calls decide. */
export function fold(state: RoomState, envelopes: Iterable<Envelope>): RoomState {
  let s = state
  for (const e of envelopes) s = apply(s, e)
  return s
}
