import {
	ActorId,
	BARE_OVER_EXEC,
	feedLines,
	GM,
	helpText,
	intake,
	isRefused,
	parseInputLine,
	sheetOf,
	tableLabel,
	unknownHelpTopic,
} from "@supervillain/domain";
import type {
	Command,
	FeedLine,
	Surface,
	TableState,
} from "@supervillain/domain";
import type { Line } from "@supervillain/platform-jsonl";
import { Effect, Match, Schema } from "effect";

import { CampaignContent } from "../content/index.ts";
import { AutoFoes } from "./AutoFoes.ts";
import { shownState } from "./check.ts";
import type { TableServices } from "./services.ts";
import { Refusal, TableRoom } from "./TableRoom.ts";

export type Reply =
	| { readonly kind: "done"; readonly lines: ReadonlyArray<FeedLine> }
	| { readonly kind: "message"; readonly text: string }
	| { readonly kind: "refusal"; readonly text: string }
	| { readonly kind: "empty" };

const RECENT = 8;

const message = (text: string): Reply => ({ kind: "message", text });

const refusal = (text: string): Reply => ({ kind: "refusal", text });

const EMPTY: Reply = { kind: "empty" };

const BARE_WORD = /^\S+/u;

const decodeActor = Schema.decodeUnknownEffect(ActorId);

const send = Effect.fn("runLine.send")(function* (
	actor: string,
	command: Command,
	rateKey: string
) {
	const room = yield* TableRoom;
	const { ruleset } = yield* CampaignContent;

	const id = yield* decodeActor(actor).pipe(
		Effect.mapError(
			(cause) =>
				new Refusal({ message: `${actor} can't sit at this table.`, cause })
		)
	);

	const filled = yield* intake(id, command, yield* room.state).pipe(
		Effect.mapError((refused) => new Refusal({ message: refused.message }))
	);

	const accepted = yield* room.submit(id, filled, rateKey);
	const state = yield* room.state;
	const seqs = new Set(accepted.seqs);

	const lines = feedLines(state, tableLabel(state, ruleset)).filter((line) =>
		seqs.has(line.seq)
	);

	const reply: Reply = { kind: "done", lines };

	return reply;
});

export const runLine = (
	actor: string,
	line: string,
	surface: Surface = "seat",
	rateKey: string = actor
): Effect.Effect<Reply, never, TableServices> =>
	Effect.gen(function* () {
		const room = yield* TableRoom;
		const { ruleset } = yield* CampaignContent;
		const parsed = parseInputLine(line, "chat", ruleset);

		return yield* Match.value(parsed).pipe(
			Match.discriminatorsExhaustive("kind")({
				empty: (): Effect.Effect<Reply> => Effect.succeed(EMPTY),
				refusal: (refused) => Effect.succeed(refusal(refused.message)),
				help: (help) => {
					const unknown = unknownHelpTopic(help.topic, ruleset);

					return Effect.succeed(
						unknown === undefined
							? message(helpText(actor, help.topic, surface, ruleset))
							: refusal(unknown)
					);
				},
				sheet: (sheet) =>
					room.state.pipe(
						Effect.map((state) => {
							const text = sheetOf(state, sheet.who, ruleset);

							return isRefused(text) ? refusal(text.refusal) : message(text);
						})
					),
				state: () => stateLine(actor, room),
				auto: (auto) => autoLine(actor, auto.foes),
				quit: () =>
					Effect.succeed(
						refusal("There's no seat to leave: this command ends by itself.")
					),
				command: (command) =>
					send(actor, command.command, rateKey).pipe(
						Effect.catchTag("Refusal", (refused) =>
							Effect.succeed(refusal(refused.message))
						)
					),
			})
		);
	}).pipe(Effect.withSpan("runLine"));

const stateLine = Effect.fn("runLine.state")(function* (
	actor: string,
	room: TableRoom["Service"]
) {
	if (actor !== GM) {
		return refusal("Only the GM can use /state.");
	}

	const recent = yield* room
		.recent(RECENT)
		.pipe(Effect.orElseSucceed((): ReadonlyArray<Line> => []));

	return message(debugText(yield* room.state, recent));
});

const autoLine = Effect.fn("runLine.auto")(function* (
	actor: string,
	foes: boolean | undefined
) {
	if (actor !== GM) {
		return refusal("Only the GM can use /auto.");
	}

	const auto = yield* AutoFoes;

	if (foes === undefined) {
		return message(
			(yield* auto.on)
				? "The table plays the foes' turns; /auto foes off stops it."
				: "You play the foes' turns; /auto foes on lets the table play them."
		);
	}

	yield* auto.set(foes);

	return message(
		foes
			? "The table plays the foes' turns now: each attacks the nearest of the party in reach, else closes in, else rests."
			: "You play the foes' turns again."
	);
});

export const execLine = (command: string): string => {
	const word = BARE_WORD.exec(command)?.[0];

	return word !== undefined && BARE_OVER_EXEC.has(word.toLowerCase())
		? `/${command}`
		: command;
};

export const debugText = (
	state: TableState,
	recent: ReadonlyArray<Line>
): string =>
	[
		JSON.stringify(shownState(state), null, 2),
		"",
		`last ${recent.length} envelopes:`,
		...recent.map((line) => JSON.stringify(line)),
	].join("\n");
