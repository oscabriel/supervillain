/**
 * What a seat may do with one hero, creature or fighter, for the table's mouse: each choice in the
 * menu a click on a token opens, as the command line it sends. The rules project these (each
 * ruleset its own) and the table only shows them and fills in what was clicked, so a click sends
 * exactly what typing would, and whatever the rules refuse is refused the same way.
 */

/**
 * What a choice needs clicked before it is sent: nothing, a square (`/move vex c5`), one creature
 * (`/attack ada grub`), or any number of them and then Roll (`/pr vex Gouge on g1 g2`).
 */
export type ActionPick = "none" | "square" | "target" | "targets";

export interface TokenAction {
  /** The menu's word for it: `Move`, an ability's name, `End turn`. */
  readonly label: string;
  readonly pick: ActionPick;
  /** The line without what is clicked for it: `/move vex`, `/pr vex Gouge`, `/done`. */
  readonly line: string;
}

/**
 * The line a choice sends with what was clicked for it: a square or a target after the line, and
 * targets after `on`, as `/pr` takes them. A roll with no targets clicked is the line alone.
 */
export function actionLine(action: TokenAction, picked: ReadonlyArray<string>): string {
  if (picked.length === 0) return action.line;
  return action.pick === "targets"
    ? `${action.line} on ${picked.join(" ")}`
    : `${action.line} ${picked[0]}`;
}
