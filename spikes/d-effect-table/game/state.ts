import type { EventType } from "./events.ts"

export interface Creature {
  id: string
  name: string
  stamina: number
  max: number
}

/** A rendered feed line; names are resolved when the event is applied. `kind` is for styling. */
export interface FeedEntry {
  seq: number
  actor: string
  kind: EventType
  text: string
}

export interface RoomState {
  seq: number
  names: Record<string, string>
  creatures: Creature[]
  feed: FeedEntry[]
}

export const initialState: RoomState = { seq: 0, names: {}, creatures: [], feed: [] }

export const FEED_LIMIT = 500

/** Display label for an actor: its name, else "GM", else the first 8 chars of the key fingerprint. */
export function actorLabel(state: RoomState, actor: string): string {
  return state.names[actor] || defaultLabel(actor)
}

/** The label an actor has before it picks a name. */
export function defaultLabel(actor: string): string {
  if (actor === "gm") return "GM"
  return actor.replace(/^key:/, "").replace(/^SHA256:/, "").slice(0, 8)
}
