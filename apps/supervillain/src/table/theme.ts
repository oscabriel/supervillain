import { type FeedFormat, feedFormat } from "../game/index.ts";
import type { Present } from "./view.ts";

export const color = {
  brand: "#e06c75",
  text: "#d0d0d0",
  bright: "#ffffff",
  dim: "#808080",
  border: "#5c6370",
  gm: "#e5c07b",
  you: "#98c379",
  dice: "#56b6c2",
  game: "#e5c07b",
  notice: "#e5c07b",
  debug: "#98c379",
  cursorFg: "#000000",
  cursorBg: "#d0d0d0",
} as const;

/** How a feed line of one kind looks: how it reads (from its module) and its colours. */
export interface FeedStyle extends FeedFormat {
  readonly who: string;
  readonly text: string;
}

const COLOURS: Readonly<Record<string, { readonly who: string; readonly text: string }>> = {
  chat: { who: color.bright, text: color.text },
  emote: { who: color.bright, text: color.text },
  narration: { who: color.gm, text: color.gm },
  roll: { who: color.dice, text: color.dice },
  name: { who: color.dim, text: color.dim },
};
const GAME = { who: color.game, text: color.game };

/** Core's kinds have their own colours; any other module's kind is drawn in the game colour. */
export function feedStyle(kind: string): FeedStyle {
  return { ...feedFormat(kind), ...(COLOURS[kind] ?? GAME) };
}

/** One entry per actor (a key with two seats open is one person), in arrival order. */
export function people(present: ReadonlyArray<Present>): ReadonlyArray<Present> {
  const seen = new Set<string>();
  return present.filter((p) => !seen.has(p.actor) && seen.add(p.actor));
}

/** "Oscar (GM)", "Alice (you)"; a GM still labelled "GM" isn't marked twice. */
export function personLabel(p: Present, me: string): string {
  const gm = p.gm && p.label !== "GM" ? " (GM)" : "";
  return `${p.label}${gm}${p.actor === me ? " (you)" : ""}`;
}

export const personColor = (p: Present, me: string): string =>
  p.gm ? color.gm : p.actor === me ? color.you : color.text;
