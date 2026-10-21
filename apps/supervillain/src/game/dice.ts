import type { Refused } from "./module.ts";
import { quote } from "./text.ts";

const MAX_DICE = 100;
const MAX_SIDES = 1000;
export const MAX_MODIFIER = 1000;

export interface Notation {
  readonly count: number;
  readonly sides: number;
  readonly modifier: number;
  /** The normal form, e.g. "2d10+3" for "2D10 + 3" and "1d20" for "d20". */
  readonly text: string;
}

/** `NdS`, `dS`, or either with `+M` or `-M`. Spaces and case don't matter. */
export function parseNotation(input: string): Notation | Refused {
  const compact = input.replace(/\s+/g, "").toLowerCase();
  const match = /^(\d*)d(\d+)([+-]\d+)?$/.exec(compact);
  if (!match) return { refusal: `"${quote(input)}" isn't dice; try 2d10+3, d20 or 3d6-1.` };
  const count = match[1] === "" ? 1 : Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] === undefined ? 0 : Number(match[3]);
  if (count < 1 || count > MAX_DICE) return { refusal: `Roll 1 to ${MAX_DICE} dice at a time.` };
  if (sides < 2 || sides > MAX_SIDES) return { refusal: `Dice have 2 to ${MAX_SIDES} sides.` };
  if (Math.abs(modifier) > MAX_MODIFIER)
    return { refusal: `Keep the modifier within ${MAX_MODIFIER}.` };
  return { count, sides, modifier, text: `${count}d${sides}${signed(modifier)}` };
}

/** "+3", "-1", or "" for 0. */
export const signed = (n: number): string => (n === 0 ? "" : n > 0 ? `+${n}` : `${n}`);
