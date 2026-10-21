import { core, labelOf } from "./core.ts";
import {
  type CombatView,
  combatView,
  completeWho,
  drawSteel,
  sheetText,
  withHeroes,
} from "./drawSteel/index.ts";
import { compose, type CommandOf, GM, type Refused, type StateOf } from "./module.ts";

/** The table's modules, in registry order. */
const modules = [core, drawSteel] as const;
type Modules = (typeof modules)[number];

export type TableState = StateOf<Modules>;
export type Command = CommandOf<Modules>;

/** Refusals name actors the way the feed does, by display name. */
const composed = compose(modules, { label: (state, actor) => labelOf(state)(actor) });

/** The engine rules for the room. */
export const rules = composed.rules;

/** The one command registry: every module's commands, each with its GM-only flag. */
export const commands = composed.commands;

/** How a feed kind reads as text, from the module that writes it. */
export const feedFormat = composed.feedFormat;

/**
 * Labels actors as the table shows them, now: a display name (else the default label), and the
 * hero a player plays beside it, "Alice (Brann)". Read it when projecting, never store it.
 */
export const tableLabel = (state: TableState): ((actor: string) => string) =>
  withHeroes(state.ds, labelOf(state));

/**
 * The Draw Steel band for one seat: combat or the party, undefined while there's neither. A hero
 * played by someone else carries their name ("Brann (Alice)"); the seat's own hero is `mine`.
 */
export const bandOf = (
  state: Pick<TableState, "ds" | "core">,
  actor: string,
): CombatView | undefined => combatView(state.ds, actor, labelOf(state));

/** The /sheet text for a hero or creature, as commands name them, or why there's none. */
export const sheetOf = (state: TableState, who: string): string | Refused =>
  sheetText(state.ds, who);

/** What Tab offers after /sheet: the heroes and creatures, the actor's own hero first. */
export const completeSheet = (
  state: TableState,
  partial: string,
  actor: string,
): ReadonlyArray<string> => completeWho(state.ds, partial, actor);

/** One feed line as it is shown: the table's `FeedLine`, built here so the rules never import the table. */
export interface FeedLine {
  readonly seq: number;
  /** The actor's label now, after the kind's mark if it has one ("↶ Oscar"). */
  readonly who: string;
  readonly kind: string;
  readonly text: string;
  /** Whether the GM wrote it. */
  readonly gm: boolean;
}

/**
 * Projects the stored feed for display. Every line is labelled with the actor's label as of now,
 * so a rename relabels that actor's earlier lines too; the feed cap never loses a name.
 *
 * Core's kinds and how their text reads:
 * - `chat`: what was said ("who: text");
 * - `emote`: an action that follows the label ("who waves");
 * - `narration`: the GM describing the scene, shown without a speaker;
 * - `roll`: follows the label ("who rolled 2d10+3: [4, 9] +3 = 16");
 * - `name`: a whole sentence naming both labels as they were then ("guest-7f3a is now Wren").
 *
 * Draw Steel's `ds`, `ds-roll` and `ds-turn` lines name their subject and have no speaker; a
 * `ds-act` line follows its label ("Alice (Brann) spends 1 hero token → 2"), and a `ds-claim` line
 * the player's name alone, whoever wrote it ("Alice takes Brann.").
 *
 * An `undo` line, from a retraction, follows its marked label and quotes the lines it took back:
 * "↶ Oscar undid: Vex takes 14 damage → 7/21 · winded". Those lines stay in the feed.
 */
export function feedLines(
  state: TableState,
  label: (actor: string) => string,
): ReadonlyArray<FeedLine> {
  const plain = labelOf(state);
  return state.feed.map((e) => {
    const speaker = e.speaker ?? e.actor;
    const format = feedFormat(e.kind);
    const who = format.plainLabel ? plain(speaker) : label(speaker);
    return {
      seq: e.seq,
      who: format.mark === undefined ? who : `${format.mark} ${who}`,
      kind: e.kind,
      text: e.text,
      gm: speaker === GM,
    };
  });
}

/** A feed line as plain text, read the way the table shows it: for exec output and `check`. */
export function plainText(line: Pick<FeedLine, "who" | "kind" | "text">): string {
  const format = feedFormat(line.kind);
  return format.speaker ? `${line.who}${format.separator}${line.text}` : line.text;
}
