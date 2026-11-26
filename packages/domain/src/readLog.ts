import { DateTime, Option, Result, Schema } from "effect";

import { CORE_EVENTS } from "./events/core.ts";
import { DS_EVENTS } from "./events/drawSteel.ts";
import { FF_EVENTS } from "./events/freeform.ts";
import { PF_EVENTS } from "./events/pf2e.ts";
import { SW_EVENTS } from "./events/setWorld.ts";
import { STAGE_EVENTS } from "./events/stage.ts";
import { initial, rules } from "./rules/compose.ts";
import type { TableState } from "./rules/compose.ts";
import { messageOf } from "./rules/engine.ts";
import type { Envelope } from "./rules/engine.ts";
import { DEFAULT_RULESET } from "./Ruleset.ts";
import type { RulesetName } from "./Ruleset.ts";
import { envelopeOf } from "./Table.aggregate.ts";
import { feedLines, tableLabel } from "./table.ts";
import type { FeedLine } from "./table.ts";
import { eventHead } from "./tagged.ts";

const LogLine = Schema.fromJsonString(
	Schema.Struct({
		actor: Schema.String,
		seq: Schema.Int,
		timestamp: Schema.String,
		type: Schema.String,
		payload: Schema.Record(Schema.String, Schema.Json),
	})
);

const decodeLine = Schema.decodeUnknownResult(LogLine);

const decodeEvent = Schema.decodeUnknownResult(
	Schema.Union([
		...CORE_EVENTS,
		...STAGE_EVENTS,
		...DS_EVENTS,
		...SW_EVENTS,
		...PF_EVENTS,
		...FF_EVENTS,
	])
);

export interface Skipped {
	readonly line: number;
	readonly seq?: number;
	readonly type?: string;
	readonly reason: string;
}

export interface LogError {
	readonly line: number;
	readonly seq: number;
	readonly message: string;
}

export interface ReadLog {
	readonly state: TableState;
	readonly feed: ReadonlyArray<FeedLine>;
	readonly skipped: ReadonlyArray<Skipped>;
	readonly error?: LogError;
}

type Step =
	| { readonly kind: "applied"; readonly state: TableState }
	| {
			readonly kind: "skipped";
			readonly state: TableState;
			readonly why: Skipped;
	  }
	| { readonly kind: "halted"; readonly error: LogError };

const normalTime = (timestamp: string): string | undefined =>
	Option.getOrUndefined(
		Option.map(DateTime.make(timestamp), DateTime.formatIso)
	);

const applied = (state: TableState, envelope: Envelope, line: number): Step => {
	try {
		return { kind: "applied", state: rules.apply(state, envelope) };
	} catch (error) {
		return {
			kind: "halted",
			error: { line, seq: envelope.seq, message: messageOf(error) },
		};
	}
};

const stepOf = (state: TableState, raw: string, line: number): Step => {
	const decoded = decodeLine(raw);

	if (Result.isFailure(decoded)) {
		return {
			kind: "skipped",
			state,
			why: { line, reason: `not an envelope: ${decoded.failure.message}` },
		};
	}

	const { actor, seq, timestamp, type, payload } = decoded.success;
	const at = normalTime(timestamp);

	if (at === undefined) {
		return {
			kind: "skipped",
			state,
			why: { line, seq, type, reason: `timestamp ${timestamp} is not a time` },
		};
	}

	if (!rules.knows(type)) {
		return {
			kind: "skipped",
			state: rules.skip(state, { actor, seq, timestamp: at, type, payload }),
			why: { line, seq, type, reason: `unknown event type "${type}"` },
		};
	}

	const event = decodeEvent({ ...payload, ...eventHead({ type, actor }) });

	if (Result.isFailure(event)) {
		return {
			kind: "skipped",
			state: rules.skip(state, { actor, seq, timestamp: at, type, payload }),
			why: { line, seq, type, reason: event.failure.message },
		};
	}

	return applied(state, envelopeOf(event.success, seq, at), line);
};

export const readLog = (
	lines: ReadonlyArray<string>,
	ruleset: RulesetName = DEFAULT_RULESET
): ReadLog => {
	let state = initial;
	const skipped: Array<Skipped> = [];

	for (const [index, raw] of lines.entries()) {
		if (raw.trim() !== "") {
			const step = stepOf(state, raw, index + 1);

			if (step.kind === "halted") {
				return {
					state,
					feed: feedLines(state, tableLabel(state, ruleset)),
					skipped,
					error: step.error,
				};
			}

			if (step.kind === "skipped") {
				skipped.push(step.why);
			}

			({ state } = step);
		}
	}

	return { state, feed: feedLines(state, tableLabel(state, ruleset)), skipped };
};
