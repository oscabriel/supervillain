import type { Envelope } from "./envelope.ts";
import type { Rules } from "./rules.ts";

export interface Folded<S> {
  /** The state after the last event applied. */
  readonly state: S;
  /** Events of unknown type that a lenient fold passed over. */
  readonly skipped: ReadonlyArray<Envelope>;
  /** Where the fold stopped. Strict folds stop at an unknown type; every fold stops where `apply` throws. */
  readonly error?: { readonly seq: number; readonly message: string };
}

/**
 * Replays envelopes through a game's rules. Replay never calls `decide`, so it never rolls.
 * The writer folds strictly, so it halts on what it can't apply; readers fold leniently and report what they skipped.
 */
export function fold<S, C>(
  rules: Rules<S, C>,
  envelopes: ReadonlyArray<Envelope>,
  options: { readonly strict: boolean },
): Folded<S> {
  let state = rules.initial;
  const skipped: Envelope[] = [];
  for (const envelope of envelopes) {
    if (!rules.knows(envelope.type)) {
      if (options.strict)
        return {
          state,
          skipped,
          error: { seq: envelope.seq, message: `unknown event type "${envelope.type}"` },
        };
      skipped.push(envelope);
      if (rules.skip) state = rules.skip(state, envelope);
      continue;
    }
    try {
      state = rules.apply(state, envelope);
    } catch (e) {
      return {
        state,
        skipped,
        error: { seq: envelope.seq, message: e instanceof Error ? e.message : String(e) },
      };
    }
  }
  return { state, skipped };
}
