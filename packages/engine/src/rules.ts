import type { Envelope } from "./envelope.ts";

/** Rolls one die with the given number of sides. The host supplies it; rules never roll on their own. */
export type Dice = (sides: number) => number;

export interface NewEvent {
  readonly type: string;
  readonly payload: unknown;
}

export type Decision = { readonly events: ReadonlyArray<NewEvent> } | { readonly refusal: string };

/** A game, as pure functions. Rules never touch the clock, files, or `Math.random`. */
export interface Rules<S, C> {
  readonly initial: S;
  /** Whether `apply` understands an event type. */
  readonly knows: (type: string) => boolean;
  /** Turns a command into events or a refusal. Randomness comes only from `dice` and lands in the payload. */
  readonly decide: (state: S, actor: string, command: C, dice: Dice) => Decision;
  /** Folds one event. Throws on an event it can't apply. */
  readonly apply: (state: S, envelope: Envelope) => S;
  /**
   * Told about an event a lenient fold skipped because `knows` said no, so the rules can keep
   * count of it (a later event may name it). Optional; a strict fold halts instead.
   */
  readonly skip?: (state: S, envelope: Envelope) => S;
}
