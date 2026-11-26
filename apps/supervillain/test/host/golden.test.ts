import { describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { feedLines, readLog, tableLabel } from "@supervillain/domain";
import type { TableState } from "@supervillain/domain";
import { parseLog } from "@supervillain/platform-jsonl";
import {
	DateTime,
	Effect,
	Exit,
	Layer,
	Logger,
	Option,
	Schema,
	Scope,
} from "effect";

import { checkLog } from "../../src/host/check.ts";
import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { openSampleCampaign } from "./campaign.ts";
import { effect } from "./effect.ts";
import { unreachable } from "./setWorld.ts";

const ALICE = "key:SHA256:goldenALICEgoldenALICEgoldenALICEgoldenALICE0";

const BOB = "key:SHA256:goldenBOBgoldenBOBgoldenBOBgoldenBOBgoldenBOB01";

const shown = (reply: Reply) => JSON.stringify(reply);

const keysOf = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

const decodeEnvelope = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			actor: Schema.String,
			seq: Schema.Int,
			timestamp: Schema.String,
			type: Schema.String,
			payload: Schema.Record(Schema.String, Schema.Json),
		})
	)
);

const FIGHT: ReadonlyArray<readonly [string, string]> = [
	[ALICE, "/name Alice"],
	[BOB, "/name Bob"],
	["gm", "/hero brann"],
	["gm", "/hero kesh"],
	[ALICE, "/play brann"],
	[BOB, "/play kesh"],
	["gm", "/add bandit-cutpurse x2"],
	["gm", "/add bandit-chief"],
	["gm", "/map ford"],
	["gm", "/place brann b5"],
	["gm", "/place kesh b6"],
	["gm", "/place bandit-chief h5"],
	["gm", "The river runs high tonight."],
	["gm", "/start"],
	["gm", "/first heroes"],
	[ALICE, "/turn"],
	[ALICE, "/move brann c5"],
	[ALICE, "/pr brann driving"],
	["gm", "/dmg bandit-cutpurse-a 7"],
	["gm", "/undo"],
	["gm", "/redo"],
	[ALICE, "/cond brann slowed save"],
	[ALICE, "/done"],
	["gm", "/turn bandit-chief"],
	["gm", "/fs bandit-chief kesh"],
	["gm", "/done"],
	[BOB, "/turn"],
	[BOB, "/roll 2d10+2"],
	[BOB, "/done"],
	["gm", "/turn bandit-cutpurse-a"],
	["gm", "/done"],
	["gm", "/round"],
	["gm", "/malice +2"],
	[ALICE, "/res brann +1"],
	["gm", "/end"],
	["gm", "/rest"],
];

const ENVELOPE_KEYS = ["actor", "seq", "timestamp", "type", "payload"];

const opened = <A, E, R>(dir: string, body: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();

		const context = yield* Layer.buildWithScope(
			tableServices(dir, { setWorld: unreachable }).pipe(
				Layer.provide(Logger.layer([]))
			),
			scope
		);

		const result = yield* body.pipe(Effect.provideContext(context));
		yield* Scope.close(scope, Exit.void);

		return result;
	});

const roomState = Effect.flatMap(TableRoom, (room) => room.state);

describe("a Draw Steel fight through the table room and the JSONL log", () => {
	effect(
		"replays from disk to the same state, in the log's envelope, and reads back the same under check",
		() =>
			Effect.gen(function* () {
				const dir = yield* openSampleCampaign;

				const before: TableState = yield* opened(
					dir,
					Effect.gen(function* () {
						for (const [actor, typed] of FIGHT) {
							const reply = yield* runLine(actor, typed);

							if (reply.kind !== "done") {
								throw new Error(
									`${typed} by ${actor} came back ${shown(reply)}`
								);
							}
						}

						return yield* roomState;
					})
				);

				expect(before.seq).toBeGreaterThanOrEqual(FIGHT.length);
				expect(before.ds.combat.active).toBe(false);
				expect(before.feed.some((f) => f.kind === "undo")).toBe(true);
				expect(before.feed.some((f) => f.kind === "redo")).toBe(true);

				const after = yield* opened(dir, roomState);
				expect(after).toEqual(before);

				const logPath = path.join(dir, "events.jsonl");

				const text = yield* Effect.promise(
					async () => await readFile(logPath, "utf-8")
				);

				const raw = text.split("\n");
				expect(raw.at(-1)).toBe("");
				const lines = raw.slice(0, -1);
				expect(lines).toHaveLength(before.seq);

				for (const [index, written] of lines.entries()) {
					expect(Object.keys(yield* keysOf(written))).toEqual(ENVELOPE_KEYS);
					const envelope = yield* decodeEnvelope(written);
					expect(envelope.seq).toBe(index + 1);
					expect(
						Option.map(DateTime.make(envelope.timestamp), DateTime.formatIso)
					).toEqual(Option.some(envelope.timestamp));
				}

				const parsed = parseLog(text);
				expect(parsed.error).toBeUndefined();
				expect(parsed.torn).toBeUndefined();
				expect(parsed.lines).toHaveLength(lines.length);

				const read = readLog(lines, "draw-steel");
				expect(read.error).toBeUndefined();
				expect(read.skipped).toEqual([]);
				expect(read.state).toEqual(before);
				expect(read.feed).toEqual(
					feedLines(before, tableLabel(before, "draw-steel"))
				);

				const report = checkLog(logPath, text, "draw-steel");
				expect(report.error).toBeUndefined();
				expect(report.warnings).toEqual([]);
				expect(report.out[0]).toBe(
					`${logPath}: ${lines.length} events, through seq ${before.seq}, 0 skipped`
				);
			}),
		30_000
	);
});
