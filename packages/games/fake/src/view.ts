import type { GameView } from "@supervillain/core";

import { terminology } from "./content.js";
import type { FakeCommand, FakeEvent, FakeState } from "./model.js";

export const view: GameView<FakeState, FakeCommand, FakeEvent> = {
	createPanels: () => [
		{
			id: "fake-visits",
			onKey(key, input) {
				if (key.name !== "v") {
					return false;
				}
				const seat = input.table.seats.find(
					(candidate) => candidate.actor === input.table.actor
				);
				if (seat !== undefined) {
					input.dispatch({ seatId: seat.id, type: "fake.visit" });
				}
				return true;
			},
			render({ focused, state }) {
				const hint = focused ? " · v to visit" : "";
				return [
					{
						runs: [
							{ text: `Visits: ${state.visits}${hint}`, token: "primary" },
						],
					},
				];
			},
			slot: "sidebar",
		},
	],
	renderEvent(event) {
		if (event.type === "fake.seat-observed") {
			return {
				runs: [{ text: `Observed seat ${event.seatId}.`, token: "muted" }],
			};
		}

		if (event.type === "fake.visit-counted") {
			return {
				runs: [
					{ text: `${terminology.visit} ${event.visits}`, token: "accent" },
				],
			};
		}

		return null;
	},
};
