import type {
	Dice,
	Envelope,
	Rules,
	Command,
	TableState,
} from "@supervillain/domain";

import { fold } from "./fold.ts";
import { openRules } from "./open.ts";

export const GM = "gm";

export const ALICE = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";

export const BOB = "key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw";

export const GUEST = "guest:7f3a9c01";

export const START = "2026-10-20T19:00:00.000Z";

export const fixedDice = (...faces: Array<number>): Dice => {
	let i = 0;

	return () => {
		const face = faces[i];
		i += 1;

		if (face === undefined) {
			throw new Error("the fake dice ran out");
		}

		return face;
	};
};

export const noDice: Dice = () => {
	throw new Error("rolled when it should not have");
};

export class Table {
	readonly rules: Rules<TableState, Command> = openRules;
	readonly envelopes: Array<Envelope> = [];
	private clock = Date.parse(START);

	get state(): TableState {
		const folded = fold(this.rules, this.envelopes, { strict: true });

		if (folded.error) {
			throw new Error(`replay halted: ${folded.error.message}`);
		}

		return folded.state;
	}

	get now(): string {
		return new Date(this.clock).toISOString();
	}

	wait(seconds: number): void {
		this.clock += seconds * 1000;
	}

	submit(
		actor: string,
		command: Command,
		dice: Dice = noDice
	): string | undefined {
		const decision = this.rules.decide(
			this.state,
			actor,
			command,
			dice,
			this.clock
		);

		if ("refusal" in decision) {
			return decision.refusal;
		}

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

	run(actor: string, command: Command, dice: Dice = noDice): void {
		const refusal = this.submit(actor, command, dice);

		if (refusal !== undefined) {
			throw new Error(`refused: ${refusal}`);
		}
	}

	get last(): Envelope | undefined {
		return this.envelopes.at(-1);
	}
}

export const env = (
	seq: number,
	type: string,
	payload: Envelope["payload"],
	actor = GM,
	timestamp = START
): Envelope => ({ actor, seq, timestamp, type, payload });
