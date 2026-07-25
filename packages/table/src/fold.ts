import {
	CORE_ACTOR_LINKED,
	CORE_CHARACTER_BOUND,
	CORE_CHAT_POSTED,
	CORE_DICE_ROLLED,
	CORE_MAP_CLEARED,
	CORE_MAP_LOADED,
	CORE_ROOM_CREATED,
	CORE_SEAT_CLAIMED,
	CORE_TOKEN_MOVED,
	CORE_TOKEN_PLACED,
	CORE_TOKEN_REMOVED,
	createActorLinks,
	foldTokenMoved,
	foldTokenPlaced,
	foldTokenRemoved,
	isRecord,
	readActorLinkedPayload,
	readMapLoadedPayload,
} from "@supervillain/core";
import type {
	BattleMap,
	CharacterBoundPayload,
	ChatPostedPayload,
	DiceRolledPayload,
	Envelope,
	FeedLine,
	MapToken,
	NamespacedType,
	SeatClaimedPayload,
	TableView,
	TokenFold,
	ViewEntry,
} from "@supervillain/core";

/** One known-invalid event this fold refused to apply (ADR-0010): the fold
 * recognized the type but the event violated a payload shape or a fold
 * invariant. `seq` is the JSONL line number in the campaign folder. */
export interface FoldSkip {
	readonly seq: number;
	readonly type: NamespacedType;
	readonly reason: string;
}

export interface TableFold<S> {
	readonly apply: (envelope: Envelope) => FeedLine | null;
	readonly state: () => Readonly<S>;
	readonly actorLabel: (actor: string) => string;
	/** Whether two actor strings name the same person, through the linking
	 * events this log carries (ADR-0005). An adopted `guest:X` answers true
	 * against the key that adopted it, with no line of the log rewritten. */
	readonly sameActor: (left: string, right: string) => boolean;
	readonly table: () => TableView;
	/** The battle map the log has folded to, or `null` when none is loaded. */
	readonly map: () => BattleMap | null;
	/** The tokens standing on that map, in placement order. */
	readonly tokens: () => readonly MapToken[];
	/** Closes the initial replay window and returns the warning for the loud
	 * skips it swallowed: the skip's own line for a single skip, one collapsed
	 * summary for a burst, `null` when replay was clean. Idempotent — calling
	 * it again once replay is closed returns `null`. */
	readonly endReplay: () => FeedLine | null;
	/** Every loud skip this fold has recorded, replay and live alike. */
	readonly skips: () => readonly FoldSkip[];
}

const skipLine = (skip: FoldSkip): FeedLine => ({
	runs: [
		{
			text: `⚠ skipped event #${skip.seq} (${skip.type}): ${skip.reason}`,
			token: "danger",
		},
	],
});

const replaySummaryLine = (skips: readonly FoldSkip[]): FeedLine | null => {
	const [first] = skips;
	if (first === undefined) {
		return null;
	}
	if (skips.length === 1) {
		return skipLine(first);
	}
	return {
		runs: [
			{
				text: `⚠ ${skips.length} events skipped during replay (first: #${first.seq} ${first.type} — ${first.reason})`,
				token: "danger",
			},
		],
	};
};

const isRoomCreated = (payload: unknown): payload is { gameId: string } =>
	isRecord(payload) && typeof payload.gameId === "string";

const isSeatClaimed = (payload: unknown): payload is SeatClaimedPayload =>
	isRecord(payload) &&
	typeof payload.seatId === "string" &&
	payload.seatId.length > 0;

const isCharacterBound = (payload: unknown): payload is CharacterBoundPayload =>
	isRecord(payload) &&
	typeof payload.seatId === "string" &&
	(payload.characterId === null || typeof payload.characterId === "string");

const isChatPosted = (payload: unknown): payload is ChatPostedPayload =>
	isRecord(payload) && typeof payload.text === "string";

const isDiceRolled = (payload: unknown): payload is DiceRolledPayload =>
	isRecord(payload) &&
	typeof payload.notation === "string" &&
	Array.isArray(payload.rolls) &&
	payload.rolls.every((roll) => typeof roll === "number") &&
	typeof payload.modifier === "number" &&
	typeof payload.total === "number";

export const createTableFold = <S, C, E>(
	entry: ViewEntry<S, C, E>,
	gameId: string,
	actor: string
): TableFold<S> => {
	let game = entry.model.init();
	let map: BattleMap | null = null;
	let tokens: readonly MapToken[] = [];
	let replaying = true;
	const skips: FoldSkip[] = [];
	const seats: {
		actor: string;
		characterId: string | null;
		id: string;
	}[] = [];
	const table: TableView = { actor, gmSeatId: "gm", seats };
	// This log's slice of the key-equivalence graph. It is what makes a
	// historical `guest:X` line reachable after adoption: the envelope keeps
	// its original actor forever, the union answers who that is now.
	const links = createActorLinks();
	const sameActor = (left: string, right: string): boolean =>
		links.same(left, right);
	const seatFor = (
		candidateActor: string
	): { actor: string; characterId: string | null; id: string } | undefined =>
		seats.find((seat) => sameActor(seat.actor, candidateActor));
	const actorLabel = (candidateActor: string): string =>
		seatFor(candidateActor)?.id ?? candidateActor.slice(0, 8);

	// A reader holds no pen: known-invalid events are skipped loudly, never
	// fatally (ADR-0010). During the initial replay the warnings are held back
	// so a systemic problem collapses to one line instead of flooding the feed.
	const loud = (envelope: Envelope, reason: string): FeedLine | null => {
		const skip: FoldSkip = {
			reason,
			seq: envelope.seq,
			type: envelope.type,
		};
		skips.push(skip);
		return replaying ? null : skipLine(skip);
	};

	const applyRoomCreated = (envelope: Envelope): FeedLine | null => {
		if (!isRoomCreated(envelope.payload)) {
			return loud(envelope, "no game id");
		}
		return {
			runs: [
				{
					text: `room created · ${envelope.payload.gameId}`,
					token: "muted",
				},
			],
		};
	};

	const applySeatClaimed = (envelope: Envelope): FeedLine | null => {
		const { payload } = envelope;
		if (!isSeatClaimed(payload)) {
			return loud(envelope, "no seat id");
		}
		if (seats.some(({ id }) => id === payload.seatId)) {
			return loud(envelope, `seat '${payload.seatId}' is already claimed`);
		}
		if (seatFor(envelope.actor) !== undefined) {
			return loud(
				envelope,
				`${actorLabel(envelope.actor)} already holds a seat`
			);
		}
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
	};

	const applyActorLinked = (envelope: Envelope): FeedLine | null => {
		const linked = readActorLinkedPayload(envelope.payload);
		if (linked === null) {
			return loud(envelope, "linking event names no actor");
		}
		// The label is read before the union so the line says which past self
		// was absorbed, not the seat it just became.
		const absorbed = actorLabel(linked);
		links.link(envelope.actor, linked);
		return {
			runs: [
				{ text: `${absorbed} is now `, token: "muted" },
				{ text: actorLabel(envelope.actor), token: "accent" },
			],
		};
	};

	const applyCharacterBound = (envelope: Envelope): FeedLine | null => {
		const { payload } = envelope;
		if (!isCharacterBound(payload)) {
			return loud(envelope, "malformed character binding");
		}
		const seat = seats.find(({ id }) => id === payload.seatId);
		if (seat === undefined) {
			return loud(envelope, `unknown seat '${payload.seatId}'`);
		}
		seat.characterId = payload.characterId;
		return null;
	};

	const applyChatPosted = (envelope: Envelope): FeedLine | null => {
		if (!isChatPosted(envelope.payload)) {
			return loud(envelope, "no chat text");
		}
		return {
			runs: [
				{ text: `${actorLabel(envelope.actor)}: `, token: "accent" },
				{ text: envelope.payload.text, token: "primary" },
			],
		};
	};

	const applyDiceRolled = (envelope: Envelope): FeedLine | null => {
		const { payload } = envelope;
		if (!isDiceRolled(payload)) {
			return loud(envelope, "malformed dice roll");
		}
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
	};

	const applyMapLoaded = (envelope: Envelope): FeedLine | null => {
		const loaded = readMapLoadedPayload(envelope.payload);
		if (loaded === null) {
			return loud(envelope, "map payload is not a valid map");
		}
		map = loaded;
		// A token's position means nothing on a different grid: the surface a
		// load lands on is bare — last-loaded wins (ADR-0006).
		tokens = [];
		return {
			runs: [{ text: `map loaded · ${loaded.name}`, token: "muted" }],
		};
	};

	const applyToken = (envelope: Envelope): FeedLine | null => {
		let folded: TokenFold;
		if (envelope.type === CORE_TOKEN_PLACED) {
			folded = foldTokenPlaced(map, tokens, envelope.payload);
		} else if (envelope.type === CORE_TOKEN_MOVED) {
			folded = foldTokenMoved(map, tokens, envelope.payload);
		} else {
			folded = foldTokenRemoved(tokens, envelope.payload);
		}
		if (!folded.ok) {
			return loud(envelope, folded.reason);
		}
		({ tokens } = folded);
		// The map region shows the move; the feed stays a conversation.
		return null;
	};

	return {
		actorLabel,
		apply(envelope) {
			links.remember(envelope.actor);
			if (envelope.type === CORE_ACTOR_LINKED) {
				return applyActorLinked(envelope);
			}
			if (envelope.type === CORE_ROOM_CREATED) {
				return applyRoomCreated(envelope);
			}
			if (envelope.type === CORE_SEAT_CLAIMED) {
				return applySeatClaimed(envelope);
			}
			if (envelope.type === CORE_CHARACTER_BOUND) {
				return applyCharacterBound(envelope);
			}
			if (envelope.type === CORE_CHAT_POSTED) {
				return applyChatPosted(envelope);
			}
			if (envelope.type === CORE_DICE_ROLLED) {
				return applyDiceRolled(envelope);
			}
			if (envelope.type === CORE_MAP_LOADED) {
				return applyMapLoaded(envelope);
			}
			if (envelope.type === CORE_MAP_CLEARED) {
				map = null;
				tokens = [];
				return { runs: [{ text: "map cleared", token: "muted" }] };
			}
			if (
				envelope.type === CORE_TOKEN_PLACED ||
				envelope.type === CORE_TOKEN_MOVED ||
				envelope.type === CORE_TOKEN_REMOVED
			) {
				return applyToken(envelope);
			}
			// Unknown core type: a newer host taught this table nothing, so it
			// quietly misses the event rather than spamming the feed.
			if (envelope.type.startsWith("core.")) {
				return null;
			}
			if (!isRecord(envelope.payload)) {
				return loud(envelope, "payload is not an object");
			}
			const event = { type: envelope.type, ...envelope.payload } as E;
			game = entry.model.apply(game, event);
			// Unknown game types fall out here: the module's own apply and
			// renderEvent skip what its grammar does not recognize.
			return entry.view.renderEvent(event, game);
		},
		endReplay() {
			if (!replaying) {
				return null;
			}
			replaying = false;
			return replaySummaryLine(skips);
		},
		map: () => map,
		sameActor,
		skips: () => skips,
		state: () => game,
		table: () => table,
		tokens: () => tokens,
	};
};
