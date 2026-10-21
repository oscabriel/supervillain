import { type Dice, type Envelope, fold, type Rules } from "@supervillain/engine";
import { type Command, rules, type TableState } from "../../src/game/index.ts";

export const GM = "gm";
export const ALICE = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";
export const BOB = "key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw";
export const GUEST = "guest:7f3a9c01";

/** When the test clock starts. */
export const START = "2026-10-20T19:00:00.000Z";

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
 * the whole log with the engine's strict fold every time state is read. Like the room, it stamps
 * every envelope of one submission with the same actor and timestamp; its clock starts at START
 * and moves one second per submission, or as far as `wait` says.
 */
export class Table<S = TableState, C = Command> {
  readonly envelopes: Envelope[] = [];
  private clock = Date.parse(START);

  constructor(readonly rules: Rules<S, C> = defaultRules as unknown as Rules<S, C>) {}

  get state(): S {
    const folded = fold(this.rules, this.envelopes, { strict: true });
    if (folded.error) throw new Error(`replay halted: ${folded.error.message}`);
    return folded.state;
  }

  /** The time on the clock, as the host would pass it in. */
  get now(): string {
    return new Date(this.clock).toISOString();
  }

  /** Lets time pass before the next submission. */
  wait(seconds: number): void {
    this.clock += seconds * 1000;
  }

  /** Runs one command. Returns the refusal, or undefined when it was accepted. */
  submit(actor: string, command: C, dice: Dice = noDice): string | undefined {
    const decision = this.rules.decide(this.state, actor, command, dice);
    if ("refusal" in decision) return decision.refusal;
    const timestamp = this.now;
    for (const event of decision.events) {
      this.envelopes.push({
        actor,
        seq: this.envelopes.length + 1,
        timestamp,
        type: event.type,
        payload: event.payload,
      });
    }
    this.wait(1);
    return undefined;
  }

  /** Like `submit`, but fails the test on a refusal. */
  run(actor: string, command: C, dice: Dice = noDice): void {
    const refusal = this.submit(actor, command, dice);
    if (refusal !== undefined) throw new Error(`refused: ${refusal}`);
  }

  /** The last envelope written. */
  get last(): Envelope | undefined {
    return this.envelopes.at(-1);
  }
}

const defaultRules = rules;

export const env = (
  seq: number,
  type: string,
  payload: unknown,
  actor = GM,
  timestamp = START,
): Envelope => ({ actor, seq, timestamp, type, payload });
