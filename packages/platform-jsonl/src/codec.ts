import type { StoredEvent } from "@alchemy.run/domain/Platform";
import { DateTime, Effect, Option, Schema } from "effect";

import { LogError } from "./CampaignLog.ts";
import type { Line } from "./envelope.ts";

const Head = Schema.Struct({
	type: Schema.String,
	actor: Schema.String,
}).pipe(Schema.encodeKeys({ type: "_tag" }));

const Body = Schema.Record(Schema.String, Schema.Unknown);

const headKeys: ReadonlySet<string> = new Set(["_tag", "actor"]);

const decodeHead = Schema.decodeUnknownEffect(Head);

const encodeHead = Schema.encodeEffect(Head);

const decodeBody = Schema.decodeUnknownEffect(Body);

export interface Source {
	readonly id: string;
	readonly stream: string;
}

export interface Batch {
	readonly commandId: string;
	readonly at: number;
	readonly lines: ReadonlyArray<Line>;
}

const refuse = (seq: number, message: string) =>
	new LogError({ message: `seq ${seq}: ${message}` });

const refuseFrom = (seq: number, message: string, cause: Error) =>
	new LogError({ message: `seq ${seq}: ${message}`, cause });

export const epochOf = (line: Line) =>
	Option.match(DateTime.make(line.timestamp), {
		onNone: () =>
			Effect.fail(
				refuse(line.seq, `timestamp ${line.timestamp} is not a time`)
			),
		onSome: (time) => Effect.succeed(DateTime.toEpochMillis(time)),
	});

export const timestampOf = (seq: number, at: number) =>
	Option.match(DateTime.make(at), {
		onNone: () => Effect.fail(refuse(seq, `${at} is not a time`)),
		onSome: (time) => Effect.succeed(DateTime.formatIso(time)),
	});

export const eventOf = Effect.fn("codec.eventOf")(function* (line: Line) {
	const payload = yield* decodeBody(line.payload).pipe(
		Effect.mapError((cause) =>
			refuseFrom(line.seq, "payload is not an object", cause)
		)
	);

	const clash = Object.keys(payload).find((key) => headKeys.has(key));

	if (clash !== undefined) {
		return yield* refuse(line.seq, `payload carries ${clash}`);
	}

	const head = yield* encodeHead({ type: line.type, actor: line.actor }).pipe(
		Effect.mapError((cause) => refuseFrom(line.seq, cause.message, cause))
	);

	return { ...head, ...payload };
});

export const encodeLine = Effect.fn("codec.encodeLine")(function* (
	stored: StoredEvent
) {
	const { seq } = stored.envelope;

	const head = yield* decodeHead(stored.event).pipe(
		Effect.mapError((cause) =>
			refuseFrom(seq, `event has no _tag and actor: ${cause.message}`, cause)
		)
	);

	const body = yield* decodeBody(stored.event).pipe(
		Effect.mapError((cause) => refuseFrom(seq, cause.message, cause))
	);

	const payload = Object.fromEntries(
		Object.entries(body).filter(([key]) => !headKeys.has(key))
	);

	const timestamp = yield* timestampOf(seq, stored.envelope.at);

	const line: Line = {
		actor: head.actor,
		seq,
		timestamp,
		type: head.type,
		payload,
	};

	return line;
});

export const encodeLines = Effect.fn("codec.encodeLines")(function* (
	events: ReadonlyArray<StoredEvent>
) {
	const lines = yield* Effect.forEach(events, (stored) => encodeLine(stored), {
		concurrency: 1,
	});

	const [first] = lines;
	const stranger = lines.find((line) => line.actor !== first?.actor);

	if (first !== undefined && stranger !== undefined) {
		return yield* refuse(
			stranger.seq,
			`one command's events name two actors, ${first.actor} and ${stranger.actor}`
		);
	}

	return lines;
});

export const decodeStoredEvent = Effect.fn("codec.decodeStoredEvent")(
	function* (line: Line, source: Source, commandId: string) {
		const event = yield* eventOf(line);
		const at = yield* epochOf(line);

		const stored: StoredEvent = {
			event,
			envelope: {
				id: source.id,
				stream: source.stream,
				seq: line.seq,
				at,
				commandId,
				correlationId: commandId,
			},
		};

		return stored;
	}
);

const sameBatch = (a: Line, b: Line) =>
	a.actor === b.actor && a.timestamp === b.timestamp;

export const batchesOf = Effect.fn("codec.batchesOf")(function* (
	lines: ReadonlyArray<Line>
) {
	const batches: Array<Batch> = [];
	let start = 0;

	for (const [index, line] of lines.entries()) {
		const next = lines[index + 1];

		if (next === undefined || !sameBatch(line, next)) {
			const group = lines.slice(start, index + 1);
			const [first] = group;

			if (first !== undefined) {
				const at = yield* epochOf(first);
				batches.push({ commandId: `log:${first.seq}`, at, lines: group });
			}

			start = index + 1;
		}
	}

	return batches;
});

export const decodeBatch = Effect.fn("codec.decodeBatch")(function* (
	batch: Batch,
	source: Source
) {
	return yield* Effect.forEach(
		batch.lines,
		(line) => decodeStoredEvent(line, source, batch.commandId),
		{ concurrency: 1 }
	);
});
