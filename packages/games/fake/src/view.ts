import type { GameView } from "@supervillain/core";

import { terminology } from "./content.js";
import type { FakeCommand, FakeEvent, FakeState } from "./model.js";

export const view: GameView<FakeState, FakeCommand, FakeEvent> = {
  renderEvent(event) {
    if (event.type === "fake.seat-observed") {
      return { runs: [{ text: `Observed seat ${event.seatId}.`, token: "muted" }] };
    }

    return {
      runs: [{ text: `${terminology.visit} ${event.visits}`, token: "accent" }],
    };
  },
  panels: [
    {
      id: "fake-visits",
      slot: "sidebar",
      render({ state }) {
        return {
          runs: [{ text: `Visits: ${state.visits}`, token: "primary" }],
        };
      },
    },
  ],
};
