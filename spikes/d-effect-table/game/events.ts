import * as Schema from "effect/Schema"

export interface Envelope {
  actor: string
  seq: number
  timestamp: string
  type: string
  payload: unknown
}

export const ChatPosted = Schema.Struct({ text: Schema.String })
export const DiceRolled = Schema.Struct({
  notation: Schema.String,
  rolls: Schema.Array(Schema.Int),
  modifier: Schema.Int,
  total: Schema.Int,
})
export const NameSet = Schema.Struct({ name: Schema.String })
export const CreatureAdded = Schema.Struct({ id: Schema.String, name: Schema.String, stamina: Schema.Int })
export const StaminaChanged = Schema.Struct({
  id: Schema.String,
  delta: Schema.Int,
  reason: Schema.Literals(["damage", "heal"]),
})

export type ChatPosted = Schema.Schema.Type<typeof ChatPosted>
export type DiceRolled = Schema.Schema.Type<typeof DiceRolled>
export type NameSet = Schema.Schema.Type<typeof NameSet>
export type CreatureAdded = Schema.Schema.Type<typeof CreatureAdded>
export type StaminaChanged = Schema.Schema.Type<typeof StaminaChanged>

export interface EventPayloads {
  "chat.posted": ChatPosted
  "dice.rolled": DiceRolled
  "name.set": NameSet
  "creature.added": CreatureAdded
  "stamina.changed": StaminaChanged
}
export type EventType = keyof EventPayloads

export const eventSchemas = {
  "chat.posted": ChatPosted,
  "dice.rolled": DiceRolled,
  "name.set": NameSet,
  "creature.added": CreatureAdded,
  "stamina.changed": StaminaChanged,
} as const

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(eventSchemas, type)
}

/** A typed event for decide() to emit; the host wraps it in an Envelope. */
export function event<T extends EventType>(type: T, payload: EventPayloads[T]): { type: T; payload: EventPayloads[T] } {
  return { type, payload }
}

const EnvelopeSchema = Schema.Struct({
  actor: Schema.String,
  seq: Schema.Int,
  timestamp: Schema.String,
  type: Schema.String,
  payload: Schema.Unknown,
})
const decodeEnvelope = Schema.decodeUnknownSync(EnvelopeSchema)

export interface ParsedLog {
  envelopes: Envelope[]
  /** The text up to the last newline; anything after it is `torn`. */
  intact: string
  torn: string | undefined
  /** The first bad line (malformed or out of sequence); envelopes stop before it. */
  error: { line: number; message: string } | undefined
}

/** The one log reader, shared by the host's replay and `check`. Pure: text in, envelopes out. */
export function parseLog(text: string): ParsedLog {
  const keep = text.lastIndexOf("\n") + 1
  const intact = text.slice(0, keep)
  const torn = keep < text.length ? text.slice(keep) : undefined
  const lines = intact === "" ? [] : intact.slice(0, -1).split("\n")
  const envelopes: Envelope[] = []
  for (const [i, line] of lines.entries()) {
    const at = (message: string): ParsedLog => ({ envelopes, intact, torn, error: { line: i + 1, message } })
    let env: Envelope
    try {
      env = decodeEnvelope(JSON.parse(line))
    } catch (e) {
      return at(`malformed line: ${e instanceof Error ? e.message : String(e)}`)
    }
    const expected = envelopes.length + 1
    if (env.seq !== expected) return at(`seq gap: expected ${expected}, found ${env.seq}`)
    envelopes.push(env)
  }
  return { envelopes, intact, torn, error: undefined }
}
