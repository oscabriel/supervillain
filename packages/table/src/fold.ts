import {
	CORE_CHAT_POSTED,
	CORE_DICE_ROLLED,
	CORE_ROOM_CREATED,
	CORE_SEAT_CLAIMED,
} from "@supervillain/core";
import type {
	ChatPostedPayload,
	DiceRolledPayload,
	Envelope,
	SeatClaimedPayload,
	FeedLine,
	TableView,
	ViewEntry,
} from "@supervillain/core";

export interface TableFold<S> {
	readonly apply: (envelope: Envelope) => FeedLine | null;
	readonly state: () => Readonly<S>;
	readonly actorLabel: (actor: string) => string;
	readonly table: () => TableView;
}

export const createTableFold = <S, C, E>(
	entry: ViewEntry<S, C, E>,
	gameId: string,
	actor: string
): TableFold<S> => {
	let game = entry.model.init();
	const seats: { actor: string; id: string }[] = [];
	const table: TableView = { actor, gmSeatId: "gm", seats };
	const actorLabel = (candidateActor: string): string =>
		table.seats.find((seat) => seat.actor === candidateActor)?.id ??
		candidateActor.slice(0, 8);
	return {
		actorLabel,
		apply(envelope) {
			if (envelope.type === CORE_ROOM_CREATED) {
				const payload = envelope.payload as { readonly gameId?: unknown };
				return {
					runs: [
						{
							text: `room created · ${String(payload.gameId)}`,
							token: "muted",
						},
					],
				};
			}
			if (envelope.type === CORE_SEAT_CLAIMED) {
				const payload = envelope.payload as SeatClaimedPayload;
				seats.push({ actor: envelope.actor, id: payload.seatId });
				return {
					runs: [
						{
							text: `${payload.seatId} joined the table`,
							token: "muted",
						},
					],
				};
			}
			if (envelope.type === CORE_CHAT_POSTED) {
				const payload = envelope.payload as ChatPostedPayload;
				return {
					runs: [
						{ text: `${actorLabel(envelope.actor)}: `, token: "accent" },
						{ text: payload.text, token: "primary" },
					],
				};
			}
			if (envelope.type === CORE_DICE_ROLLED) {
				const payload = envelope.payload as DiceRolledPayload;
				return {
					runs: [
						{ text: actorLabel(envelope.actor), token: "accent" },
						{
							text: ` rolled ${payload.notation} → ${payload.rolls.join(", ")} = `,
							token: "primary",
						},
						{ text: String(payload.total), token: "success" },
					],
				};
			}
			if (envelope.type.startsWith("core.")) {
				return null;
			}
			if (typeof envelope.payload !== "object" || envelope.payload === null) {
				return null;
			}
			const event = { type: envelope.type, ...envelope.payload } as E;
			game = entry.model.apply(game, event);
			return entry.view.renderEvent(event, game);
		},
		state: () => game,
		table: () => table,
	};
};
