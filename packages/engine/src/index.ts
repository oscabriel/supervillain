/** One line of the campaign log. `seq` is the line number, starting at 1. */
export interface Envelope {
  readonly actor: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: unknown;
}
