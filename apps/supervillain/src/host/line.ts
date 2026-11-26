import {
	ActorId,
	ambiguousKnocker,
	BARE_OVER_EXEC,
	cardLines,
	codexText,
	stagedCardOf,
	feedLines,
	GM,
	helpText,
	intake,
	isRefused,
	MemberRemoved,
	parseInputLine,
	quote,
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
import { Clock, Effect, Match, Result, Schema } from "effect";

import { CampaignContent } from "../content/index.ts";
import { AutoFoes } from "./AutoFoes.ts";
import { shownState } from "./check.ts";
import { inviteCommand, KNOCK_LIMITS, knockLabel, Knocks } from "./Knocks.ts";
import { Presence } from "./Presence.ts";
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

const isRemoval = Schema.is(MemberRemoved);

const MINUTE_MS = 60_000;

export interface Sent {
	readonly seqs: ReadonlyArray<number>;
	readonly lines: ReadonlyArray<FeedLine>;
}

export const sendCommand = Effect.fn("runLine.send")(function* (
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
	const presence = yield* Presence;

	yield* Effect.forEach(
		accepted.events.flatMap((event) =>
			isRemoval(event) ? [event.member] : []
		),
		(member) => presence.kick(member),
		{ concurrency: 1, discard: true }
	);

	const state = yield* room.state;
	const seqs = new Set(accepted.seqs);

	const lines = feedLines(state, tableLabel(state, ruleset)).filter((line) =>
		seqs.has(line.seq)
	);

	const sent: Sent = { seqs: accepted.seqs, lines };

	return sent;
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
				codex: (codex) => codexLine(actor, codex.ref),
				auto: (auto) => autoLine(actor, auto.foes),
				deny: (deny) => denyLine(actor, deny.who),
				invite: (invite) => inviteLine(actor, invite),
				quit: () =>
					Effect.succeed(
						refusal("There's no seat to leave: this command ends by itself.")
					),
				command: (command) =>
					sendCommand(actor, command.command, rateKey).pipe(
						Effect.map((sent): Reply => ({ kind: "done", lines: sent.lines })),
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

const withNotes = (text: string, notes: string | undefined): string =>
	notes === undefined
		? text
		: `${text}\n\nGM notes (only you see these):\n${notes}`;

const codexLine = Effect.fn("runLine.codex")(function* (
	actor: string,
	ref: string | undefined
) {
	const room = yield* TableRoom;
	const state = yield* room.state;
	const text = codexText(state, ref);

	if (actor !== GM || ref === undefined) {
		return isRefused(text) ? refusal(text.refusal) : message(text);
	}

	const content = yield* CampaignContent;
	const staged = stagedCardOf(state, ref);

	if (staged !== undefined) {
		return message(
			withNotes(
				cardLines(staged).join("\n"),
				yield* content.gmNotes(staged.key)
			)
		);
	}

	const card = yield* Effect.result(content.card(ref));

	if (Result.isFailure(card)) {
		return refusal(card.failure.message);
	}

	return message(
		withNotes(
			`${cardLines(card.success).join("\n")}\n\n(Not shown to the table: /show or /reveal it.)`,
			yield* content.gmNotes(card.success.key)
		)
	);
});

export const autoLine = Effect.fn("runLine.auto")(function* (
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

export const denyLine = Effect.fn("runLine.deny")(function* (
	actor: string,
	who: string
) {
	if (actor !== GM) {
		return refusal("Only the GM can use /deny.");
	}

	const knocks = yield* Knocks;
	const ambiguous = ambiguousKnocker(yield* knocks.pending.get, who, "deny");

	if (ambiguous !== undefined) {
		return refusal(ambiguous);
	}

	const denied = yield* knocks.deny(who);

	return denied === undefined
		? refusal(`Nobody called "${quote(who)}" is knocking.`)
		: message(
				`Turned away ${knockLabel(denied)}; they can't knock again for ${KNOCK_LIMITS.cooldownMs / MINUTE_MS} minutes.`
			);
});

export const inviteLine = Effect.fn("runLine.invite")(function* (
	actor: string,
	ask: { readonly uses?: number; readonly minutes?: number }
) {
	if (actor !== GM) {
		return refusal("Only the GM can use /invite.");
	}

	const knocks = yield* Knocks;
	const made = yield* Effect.result(knocks.invite(ask));

	if (Result.isFailure(made)) {
		return refusal(made.failure.message);
	}

	const { token, uses, until } = made.success;
	const now = yield* Clock.currentTimeMillis;
	const join = yield* knocks.joinCommand;
	const minutes = Math.max(1, Math.round((until - now) / MINUTE_MS));
	const lasts = `${uses} use${uses === 1 ? "" : "s"}, ${minutes} min`;

	return message(
		join === undefined
			? `Invite ~${token} (${lasts}): players add ~${token} after the table's name when they join. It is never written to the log.`
			: `Invite (${lasts}): ${inviteCommand(join, token)}`
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
