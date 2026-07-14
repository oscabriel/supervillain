import type { GameView } from "@supervillain/core";

import { terminology } from "./content.js";
import type { FakeCommand, FakeEvent, FakeState } from "./model.js";

export const view: GameView<FakeState, FakeCommand, FakeEvent> = {
	panels: [
		{
			id: "fake-visits",
			render({ state }) {
				return {
					runs: [{ text: `Visits: ${state.visits}`, token: "primary" }],
				};
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

		return {
			runs: [{ text: `${terminology.visit} ${event.visits}`, token: "accent" }],
		};
	},
};
