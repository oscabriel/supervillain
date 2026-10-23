import type { TokenAction } from "./actions.ts";
import { core, labelOf } from "./core.ts";
import {
  type CombatView,
  combatView,
  completeWho,
  drawSteel,
  type MapView,
  mapView,
  sheetText,
  tokenActions,
  withHeroes,
} from "./drawSteel/index.ts";
import { compose, type CommandOf, GM, type Refused, type StateOf } from "./module.ts";
import {
  completeFighters,
  setActions,
  setBand,
  setMap,
  setSheet,
  setWorld,
  withFighters,
} from "./setWorld/index.ts";

/**
 * The table's modules, in registry order. Every one is always composed, so one fold replays any
 * log whatever the campaign plays; the campaign's ruleset only chooses which commands its table
 * offers and what its seats see.
 */
const modules = [core, drawSteel, setWorld] as const;
type Modules = (typeof modules)[number];

export type TableState = StateOf<Modules>;
export type Command = CommandOf<Modules>;

/** The rulesets a campaign may play (its `campaign.yaml` says which), by the name it's written as. */
export const RULESETS = ["draw-steel", "set-world"] as const;
export type Ruleset = (typeof RULESETS)[number];

/** What a campaign with no `campaign.yaml` plays: every campaign made before there was a choice. */
export const DEFAULT_RULESET: Ruleset = "draw-steel";

/** Refusals name actors the way the feed does, by display name. */
const composed = compose(modules, { label: (state, actor) => labelOf(state)(actor) });

/** The engine rules for the room. */
export const rules = composed.rules;

/** The one command registry: every module's commands, each with its GM-only flag and ruleset. */
export const commands = composed.commands;

/** The commands a table playing `ruleset` offers: core's, and that ruleset's own. */
export const commandsFor = (ruleset: Ruleset): typeof commands =>
  commands.filter((c) => c.ruleset === undefined || c.ruleset === ruleset);

/** How a feed kind reads as text, from the module that writes it. */
export const feedFormat = composed.feedFormat;

/**
 * Labels actors as the table shows them, now: a display name (else the default label), and the
 * hero or fighter a player plays in the campaign's ruleset beside it, "Alice (Brann)". The other
 * ruleset's slice is never read, so a campaign that changed rulesets shows no stale hero. Read it
 * when projecting, never store it.
 */
export const tableLabel = (
  state: Pick<TableState, "ds" | "sw" | "core">,
  ruleset: Ruleset,
): ((actor: string) => string) =>
  ruleset === "set-world"
    ? withFighters(state.sw, labelOf(state))
    : withHeroes(state.ds, labelOf(state));

/**
 * The band for one seat: Draw Steel's combat or party, or set.world's fight or party, undefined
 * while there's neither. Someone else's hero or fighter carries their name ("Brann (Alice)"); the
 * seat's own is `mine`.
 */
export const bandOf = (
  state: Pick<TableState, "ds" | "sw" | "core">,
  actor: string,
  ruleset: Ruleset,
): CombatView | undefined =>
  ruleset === "set-world"
    ? setBand(state.sw, actor, labelOf(state))
    : combatView(state.ds, actor, labelOf(state));

/** The text map for one seat, from the ruleset's own slice; undefined while none is loaded. */
export const mapOf = (
  state: Pick<TableState, "ds" | "sw">,
  actor: string,
  ruleset: Ruleset,
): MapView | undefined =>
  ruleset === "set-world" ? setMap(state.sw, actor) : mapView(state.ds, actor);

/**
 * What one seat may do with a hero, creature or fighter (its id, as the map and the band carry
 * it), for the table's mouse: the campaign's ruleset's choices, each as the command it sends.
 * Undefined when the seat may not act for it.
 */
export const actionsOf = (
  state: Pick<TableState, "ds" | "sw">,
  actor: string,
  ruleset: Ruleset,
  id: string,
): ReadonlyArray<TokenAction> | undefined =>
  ruleset === "set-world" ? setActions(state.sw, actor, id) : tokenActions(state.ds, actor, id);

/** The /sheet text for a hero, creature or fighter, as commands name them, or why there's none. */
export const sheetOf = (state: TableState, who: string, ruleset: Ruleset): string | Refused =>
  ruleset === "set-world" ? setSheet(state.sw, who) : sheetText(state.ds, who);

/** What Tab offers after /sheet: the heroes and creatures, or the fighters, the actor's own first. */
export const completeSheet = (
  state: TableState,
  partial: string,
  actor: string,
  ruleset: Ruleset,
): ReadonlyArray<string> =>
  ruleset === "set-world"
    ? completeFighters(state.sw, partial, actor)
    : completeWho(state.ds, partial, actor);

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
 * the player's name alone, whoever wrote it ("Alice takes Brann."). set.world's `sw`, `sw-turn`,
 * `sw-act` and `sw-claim` read the same way.
 *
 * An `undo` line, from a retraction, follows its marked label and quotes the lines it took back:
 * "↶ Oscar undid: Vex takes 14 damage → 7/21 · winded". Those lines stay in the feed.
 */
export function feedLines(
  state: Pick<TableState, "feed" | "core">,
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
