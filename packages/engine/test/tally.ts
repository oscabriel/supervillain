import type { Envelope, Rules } from "../src/index.ts";

/** A tiny game for engine tests: a running total, dice, and commands that misbehave on purpose. */
export interface Tally {
  readonly total: number;
  readonly rolls: ReadonlyArray<number>;
}

export type TallyCommand =
  | { readonly type: "add"; readonly n: number }
  | { readonly type: "roll"; readonly sides: number }
  | { readonly type: "refuse" }
  | { readonly type: "throw" }
  | { readonly type: "poison" };

export const tally: Rules<Tally, TallyCommand> = {
  initial: { total: 0, rolls: [] },
  knows: (type) => type === "added" || type === "rolled" || type === "poisoned",
  decide: (_state, _actor, command, dice) => {
    switch (command.type) {
      case "add":
        return { events: [{ type: "added", payload: { n: command.n } }] };
      case "roll":
        return { events: [{ type: "rolled", payload: { value: dice(command.sides) } }] };
      case "refuse":
        return { refusal: "not today" };
      case "throw":
        throw new Error("decide blew up");
      case "poison":
        return {
          events: [
            { type: "added", payload: { n: 1 } },
            { type: "poisoned", payload: {} },
          ],
        };
    }
  },
  apply: (state, envelope) => {
    const payload = envelope.payload as { n?: number; value?: number };
    switch (envelope.type) {
      case "added":
        return { ...state, total: state.total + (payload.n ?? 0) };
      case "rolled":
        return {
          total: state.total + (payload.value ?? 0),
          rolls: [...state.rolls, payload.value ?? 0],
        };
      case "poisoned":
        throw new Error("apply blew up");
      default:
        throw new Error(`unknown event ${envelope.type}`);
    }
  },
};

export const env = (seq: number, type: string, payload: unknown, actor = "gm"): Envelope => ({
  actor,
  seq,
  timestamp: "2026-10-20T19:00:00.000Z",
  type,
  payload,
});
