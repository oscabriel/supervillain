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
  heroes: "#61afef",
  director: "#c678dd",
  healthy: "#98c379",
  winded: "#e5c07b",
  dying: "#ff5f5f",
  mineBg: "#3e4452",
  /** The map's terrain: greys and one muted olive, never a token's colour. */
  floor: "#5c6370",
  wall: "#8a8a8a",
  difficult: "#87875f",
  terrain: "#a8a8a8",
  /** The tint under squares the acting token can reach, and under the hint row's reach label. */
  reach: "#1f3d3d",
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

/**
 * Which labels fit in `width` columns, whole, joined by ", ", with ", +N" for the rest. `mine` is
 * kept first, so a seat always finds itself; the others go in order. Indices, in order.
 */
export function fitLabels(
  labels: ReadonlyArray<string>,
  width: number,
  mine = -1,
): { readonly shown: ReadonlyArray<number>; readonly more: number } {
  const order = [...(mine >= 0 ? [mine] : []), ...[...labels.keys()].filter((i) => i !== mine)];
  const shown: number[] = [];
  let used = 0;
  for (const [n, i] of order.entries()) {
    const add = (shown.length > 0 ? 2 : 0) + Bun.stringWidth(labels[i]!);
    const left = order.length - n - 1;
    const tail = left > 0 ? `, +${left}`.length : 0;
    if (used + add + tail > width) break;
    shown.push(i);
    used += add;
  }
  return { shown: shown.toSorted((a, b) => a - b), more: labels.length - shown.length };
}
