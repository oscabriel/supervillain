import { type Dice, type Envelope, fold } from "@supervillain/engine";
import { type Command, rules, type TableState } from "../../src/game/index.ts";

export const GM = "gm";
export const ALICE = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";
export const BOB = "key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw";
export const GUEST = "guest:7f3a9c01";

/** Dice that return the given faces in order, then complain. */
export const fixedDice = (...faces: number[]): Dice => {
  let i = 0;
  return () => {
    const face = faces[i++];
    if (face === undefined) throw new Error("the fake dice ran out");
    return face;
  };
};

/** Dice for commands that must not roll. */
export const noDice: Dice = () => {
  throw new Error("rolled when it should not have");
};

/**
 * A room without the host: decide against the replayed state, append envelopes, and replay
 * the whole log with the engine's strict fold every time state is read.
 */
export class Table {
  readonly envelopes: Envelope[] = [];

  get state(): TableState {
    const folded = fold(rules, this.envelopes, { strict: true });
    if (folded.error) throw new Error(`replay halted: ${folded.error.message}`);
    return folded.state;
  }

  /** Runs one command. Returns the refusal, or undefined when it was accepted. */
  submit(actor: string, command: Command, dice: Dice = noDice): string | undefined {
    const decision = rules.decide(this.state, actor, command, dice);
    if ("refusal" in decision) return decision.refusal;
    for (const event of decision.events) {
      this.envelopes.push({
        actor,
        seq: this.envelopes.length + 1,
        timestamp: "2026-10-20T19:00:00.000Z",
        type: event.type,
        payload: event.payload,
      });
    }
    return undefined;
  }

  /** The last envelope written. */
  get last(): Envelope | undefined {
    return this.envelopes.at(-1);
  }
}

export const env = (seq: number, type: string, payload: unknown, actor = GM): Envelope => ({
  actor,
  seq,
  timestamp: "2026-10-20T19:00:00.000Z",
  type,
  payload,
});
