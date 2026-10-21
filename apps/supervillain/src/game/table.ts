import { core } from "./core.ts";
import { compose, type CommandOf, GM, type StateOf } from "./module.ts";

/** The table's modules, in registry order. Draw Steel joins this list. */
const modules = [core] as const;
type Modules = (typeof modules)[number];

export type TableState = StateOf<Modules>;
export type Command = CommandOf<Modules>;

const composed = compose(modules);

/** The engine rules for the room. */
export const rules = composed.rules;

/** The one command registry: every module's commands, each with its GM-only flag. */
export const commands = composed.commands;

/** How a feed kind reads as text, from the module that writes it. */
export const feedFormat = composed.feedFormat;

/** One feed line as it is shown: the table's `FeedLine`, built here so the rules never import the table. */
export interface FeedLine {
  readonly seq: number;
  /** The actor's label now. */
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
 */
export function feedLines(
  state: TableState,
  labelOf: (actor: string) => string,
): ReadonlyArray<FeedLine> {
  return state.feed.map((e) => ({
    seq: e.seq,
    who: labelOf(e.actor),
    kind: e.kind,
    text: e.text,
    gm: e.actor === GM,
  }));
}

/** A feed line as plain text, read the way the table shows it: for exec output and `check`. */
export function plainText(line: Pick<FeedLine, "who" | "kind" | "text">): string {
  const format = feedFormat(line.kind);
  return format.speaker ? `${line.who}${format.separator}${line.text}` : line.text;
}
