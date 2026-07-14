import type { GameAuthority, Rejection, TableView } from "@supervillain/core";

import { apply, init, type FakeCommand, type FakeEvent, type FakeState } from "./model.js";

export function decide(
  state: Readonly<FakeState>,
  command: FakeCommand,
  table: TableView,
): FakeEvent[] | Rejection {
  if (command.type === "fake.reject") {
    return { rejected: true, message: command.reason };
  }

  const seat = table.seats.find(({ id }) => id === command.seatId);
  if (seat === undefined) {
    return { rejected: true, message: `No seat '${command.seatId}' exists at this table.` };
  }

  return [
    { type: "fake.seat-observed", seatId: seat.id },
    { type: "fake.visit-counted", visits: state.visits + 1 },
  ];
}

export const authority: GameAuthority<FakeState, FakeCommand, FakeEvent> = {
  init,
  decide,
  apply,
};
