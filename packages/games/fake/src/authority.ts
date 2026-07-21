import type { GameAuthority, Rejection, TableView } from "@supervillain/core";

import { apply, init } from "./model.js";
import type { FakeCommand, FakeEvent, FakeState } from "./model.js";

export const decide = (
	state: Readonly<FakeState>,
	command: FakeCommand,
	table: TableView
): FakeEvent[] | Rejection => {
	if (command.type === "fake.reject") {
		return { message: command.reason, rejected: true };
	}

	const seat = table.seats.find(({ id }) => id === command.seatId);
	if (seat === undefined) {
		return {
			message: `No seat '${command.seatId}' exists at this table.`,
			rejected: true,
		};
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
};
