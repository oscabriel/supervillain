import { fold, parseLog } from "@supervillain/engine";
import {
  feedLines,
  labelOf,
  plainText,
  rules,
  type TableState,
  tableLabel,
} from "../game/index.ts";

/**
 * The state as the state pane and `check` print it: the feed only counted, since it's on screen,
 * and the undo and redo stacks only counted, since each batch holds a copy of the slices it would
 * restore or the events it would put back.
 */
export const shownState = (state: TableState) => ({
  ...state,
  feed: `[${state.feed.length} lines]`,
  undo: `[${state.undo.length} ${state.undo.length === 1 ? "batch" : "batches"}]`,
  redo: `[${state.redo.length} ${state.redo.length === 1 ? "batch" : "batches"}]`,
});

export interface CheckReport {
  /** The summary, the feed and the final state, for stdout. */
  readonly out: ReadonlyArray<string>;
  /** What was skipped or cut, for stderr. */
  readonly warnings: ReadonlyArray<string>;
  /** Why the read stopped early, if it did. */
  readonly error?: string;
}

/**
 * Reads a campaign log the way any reader does: the shared parser, then a lenient fold that
 * skips unknown events loudly. Pure, so it never takes the host's lock or writes anything.
 */
export function checkLog(path: string, text: string): CheckReport {
  const parsed = parseLog(text);
  const folded = fold(rules, parsed.envelopes, { strict: false });
  const { state } = folded;
  const warnings: string[] = [];
  if (parsed.torn !== undefined)
    warnings.push(`the last line has no newline (a write that never finished); ignoring it`);
  for (const e of folded.skipped)
    warnings.push(`seq ${e.seq}: skipped unknown event type ${JSON.stringify(e.type)}`);

  const counts = new Map<string, number>();
  const applied = folded.error
    ? parsed.envelopes.filter((e) => e.seq < folded.error!.seq)
    : parsed.envelopes;
  for (const e of applied) {
    if (rules.knows(e.type)) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  const label = labelOf(state);
  const out = [
    `${path}: ${parsed.envelopes.length} events, through seq ${state.seq}, ${folded.skipped.length} skipped`,
    `events: ${[...counts].map(([type, n]) => `${type} ×${n}`).join(", ") || "none"}`,
    `actors: ${state.actors.map((a) => `${label(a)} (${a})`).join(", ") || "none"}`,
    "",
    "feed:",
    ...feedLines(state, tableLabel(state)).map(
      (l) => `${String(l.seq).padStart(6)}  ${plainText(l)}`,
    ),
    "",
    "state:",
    JSON.stringify(shownState(state), null, 2),
  ];

  const error = parsed.error
    ? `${path}:${parsed.error.line}: ${parsed.error.message} (read ${parsed.envelopes.length} lines before it)`
    : folded.error
      ? `${path}: stopped at seq ${folded.error.seq}: ${folded.error.message}`
      : undefined;
  return error === undefined ? { out, warnings } : { out, warnings, error };
}
