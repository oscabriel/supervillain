import type {
	GameAuthority,
	Rejection,
	SeatView,
	TableView,
} from "@supervillain/core";

import {
	PLEDGE_OWN_SEAT_REASON,
	apply,
	init,
	offers,
	seatOfActor,
	standingSeatOf,
} from "./model.js";
import type { FakeCommand, FakeEvent, FakeState } from "./model.js";

const seatById = (table: TableView, seatId: string): SeatView | undefined =>
	table.seats.find(({ id }) => id === seatId);

/** Whether the TableView's actor holds the GM seat (ADR-0002: authority rules
 * read the table, never command payloads). */
const actorIsGm = (table: TableView): boolean =>
	seatById(table, table.gmSeatId)?.actor === table.actor;

/** Why the actor may not resolve this decision, or undefined when they may:
 * the issuer resolves a decision on their own seat; the GM resolves any
 * seat's (ADR-0035, the GM-in-the-loop corollary applied to stuck decisions). */
const resolutionRefusal = (
	state: Readonly<FakeState>,
	table: TableView,
	decisionId: string
): Rejection | undefined => {
	const seatId = standingSeatOf(state, decisionId);
	if (seatId === undefined) {
		return {
			message: `No standing decision '${decisionId}' is waiting.`,
			rejected: true,
		};
	}
	if (actorIsGm(table)) {
		return undefined;
	}
	if (seatById(table, seatId)?.actor !== table.actor) {
		return {
			message: "Only the seated player or the GM may resolve this decision.",
			rejected: true,
		};
	}
	return undefined;
};

export const decide = (
	state: Readonly<FakeState>,
	command: FakeCommand,
	table: TableView
): FakeEvent[] | Rejection => {
	if (command.type === "fake.reject") {
		return { message: command.reason, rejected: true };
	}

	if (command.type === "fake.decision.answer") {
		const refused = resolutionRefusal(state, table, command.decisionId);
		if (refused !== undefined) {
			return refused;
		}
		const seatId = standingSeatOf(state, command.decisionId);
		const standing = seatId === undefined ? undefined : state.standing[seatId];
		if (standing === undefined || !standing.answers.includes(command.answer)) {
			return {
				message: `'${command.answer}' is not one of this decision's answers.`,
				rejected: true,
			};
		}
		const answered: FakeEvent = {
			answer: command.answer,
			decisionId: command.decisionId,
			type: "fake.decision-answered",
		};
		// Declining never undoes the pledge that already counted (ADR-0035:
		// cancel cannot undo time already spent); a "yes" is the one answer
		// with an effect, and it lands as its own visit.
		return command.answer === "yes"
			? [answered, { type: "fake.visit-counted", visits: state.visits + 1 }]
			: [answered];
	}

	if (command.type === "fake.decision.cancel") {
		const refused = resolutionRefusal(state, table, command.decisionId);
		if (refused !== undefined) {
			return refused;
		}
		return [
			{ decisionId: command.decisionId, type: "fake.decision-cancelled" },
		];
	}

	const seat = seatById(table, command.seatId);
	if (seat === undefined) {
		return {
			message: `No seat '${command.seatId}' exists at this table.`,
			rejected: true,
		};
	}

	if (command.type === "fake.pledge") {
		// The rule `offers` shows as a blocked offer, enforced here with the
		// same words: a pledge opens a decision on the actor's own seat only.
		if (seatOfActor(table) !== command.seatId) {
			return { message: PLEDGE_OWN_SEAT_REASON, rejected: true };
		}
		// One standing decision per seat: a seat still owing an answer cannot
		// open a second one.
		if (state.standing[command.seatId] !== undefined) {
			return {
				message: `Seat '${command.seatId}' already has a standing decision.`,
				rejected: true,
			};
		}
		const decisionId = `decision-${globalThis.crypto.randomUUID()}`;
		return [
			{
				characterId: seat.characterId,
				seatId: seat.id,
				type: "fake.seat-observed",
			},
			{ type: "fake.visit-counted", visits: state.visits + 1 },
			{
				answers: ["yes", "no"],
				decisionId,
				kind: "double-visit",
				prompt: "Double this visit?",
				seatId: seat.id,
				type: "fake.decision-opened",
			},
		];
	}

	return [
		{
			characterId: seat.characterId,
			seatId: seat.id,
			type: "fake.seat-observed",
		},
		{ type: "fake.visit-counted", visits: state.visits + 1 },
	];
};

export const authority: GameAuthority<FakeState, FakeCommand, FakeEvent> = {
	apply,
	decide,
	init,
	offers,
};
