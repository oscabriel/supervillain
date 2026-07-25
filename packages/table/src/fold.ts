import {
	CORE_CHARACTER_BOUND,
	CORE_CHAT_POSTED,
	CORE_DICE_ROLLED,
	CORE_MAP_CLEARED,
	CORE_MAP_LOADED,
	CORE_ROOM_CREATED,
	CORE_SEAT_CLAIMED,
	readMapLoadedPayload,
} from "@supervillain/core";
import type {
	BattleMap,
	CharacterBoundPayload,
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
	/** The battle map the log has folded to, or `null` when none is loaded. */
	readonly map: () => BattleMap | null;
}

/** Readers tolerate: a known-invalid event is skipped loudly (ADR-0010). */
const skipped = (envelope: Envelope, reason: string): FeedLine => ({
	runs: [
		{
			text: `⚠ skipped event #${envelope.seq} (${envelope.type}): ${reason}`,
			token: "danger",
		},
	],
});

export const createTableFold = <S, C, E>(
	entry: ViewEntry<S, C, E>,
	gameId: string,
	actor: string
): TableFold<S> => {
	let game = entry.model.init();
	let map: BattleMap | null = null;
	const seats: {
		actor: string;
		characterId: string | null;
		id: string;
	}[] = [];
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
				seats.push({
					actor: envelope.actor,
					characterId: null,
					id: payload.seatId,
				});
				return {
					runs: [
						{
							text: `${payload.seatId} joined the table`,
							token: "muted",
						},
					],
				};
			}
			if (envelope.type === CORE_CHARACTER_BOUND) {
				const payload = envelope.payload as CharacterBoundPayload;
				const seat = seats.find(({ id }) => id === payload.seatId);
				if (seat !== undefined) {
					seat.characterId = payload.characterId;
				}
				return null;
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
			if (envelope.type === CORE_MAP_LOADED) {
				const loaded = readMapLoadedPayload(envelope.payload);
				if (loaded === null) {
					return skipped(envelope, "map payload is not a valid map");
				}
				map = loaded;
				return {
					runs: [{ text: `map loaded · ${loaded.name}`, token: "muted" }],
				};
			}
			if (envelope.type === CORE_MAP_CLEARED) {
				map = null;
				return { runs: [{ text: "map cleared", token: "muted" }] };
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
		map: () => map,
		state: () => game,
		table: () => table,
	};
};
