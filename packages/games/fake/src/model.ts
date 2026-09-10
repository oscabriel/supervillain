import type { Offer, TableView } from "@supervillain/core";

export interface FakeState {
	readonly visits: number;
	readonly lastSeatId: string | null;
	readonly lastCharacterId: string | null;
	/** One standing decision per seat at most (ADR-0035), keyed by seat id.
	 * Opened by `apply` of a `fake.decision-opened` event, so a half-finished
	 * pledge is state, not a Panel's local buffer, and survives replay. */
	readonly standing: Readonly<Record<string, FakeStandingDecision>>;
}

/** The answers a fake decision offers. The one kind this module has asks a
 * yes/no question. */
export type FakeAnswer = "yes" | "no";

/** A standing decision as the glossary names it: an id, a kind, and the
 * offered answers (ADR-0035). The prompt is the module-owned wording a Panel
 * shows. */
export interface FakeStandingDecision {
	readonly decisionId: string;
	readonly kind: "double-visit";
	readonly prompt: string;
	readonly answers: readonly FakeAnswer[];
}

export type FakeCommand =
	| { readonly type: "fake.visit"; readonly seatId: string }
	| { readonly type: "fake.reject"; readonly reason: string }
	| { readonly type: "fake.pledge"; readonly seatId: string }
	| {
			readonly type: "fake.decision.answer";
			readonly decisionId: string;
			readonly answer: FakeAnswer;
	  }
	| { readonly type: "fake.decision.cancel"; readonly decisionId: string };

export type FakeEvent =
	| {
			readonly type: "fake.seat-observed";
			readonly seatId: string;
			readonly characterId: string | null;
	  }
	| { readonly type: "fake.visit-counted"; readonly visits: number }
	| {
			readonly type: "fake.decision-opened";
			readonly decisionId: string;
			readonly seatId: string;
			readonly kind: "double-visit";
			readonly prompt: string;
			readonly answers: readonly FakeAnswer[];
	  }
	| {
			readonly type: "fake.decision-answered";
			readonly decisionId: string;
			readonly answer: FakeAnswer;
	  }
	| { readonly type: "fake.decision-cancelled"; readonly decisionId: string };

/** Every event type this module's fold recognizes, legacy shapes included
 * (ADR-0010). Kept in step with `apply` by the conformance suite; `model.ts`
 * imports no runtime module (the type-only seam types above are erased), so
 * the entry that registers this module lifts it into an `EventGrammar`. */
export const eventTypes = [
	"fake.seat-observed",
	"fake.visit-counted",
	"fake.decision-opened",
	"fake.decision-answered",
	"fake.decision-cancelled",
] as const;

/** The one place the pledge-ownership rule is worded (ADR-0036): `offers`
 * shows it as a blocked offer's reason and `decide` refuses with it. */
export const PLEDGE_OWN_SEAT_REASON = "Only your own seat can pledge.";

export const init = (): FakeState => ({
	lastCharacterId: null,
	lastSeatId: null,
	standing: {},
	visits: 0,
});

/** The seat (if any) whose standing decision carries this id. */
export const standingSeatOf = (
	state: Readonly<FakeState>,
	decisionId: string
): string | undefined =>
	Object.keys(state.standing).find(
		(seatId) => state.standing[seatId]?.decisionId === decisionId
	);

/** The seat the TableView's actor holds, if any (ADR-0002: the actor is the
 * perspective, in `decide` and in a Panel alike). */
export const seatOfActor = (table: TableView): string | undefined =>
	table.seats.find(({ actor }) => actor === table.actor)?.id;

export const apply = (
	state: Readonly<FakeState>,
	event: FakeEvent
): FakeState => {
	switch (event.type) {
		case "fake.seat-observed": {
			// Upgrade-on-read: the pre-`characterId` shape a released host once
			// wrote still folds, normalized here rather than migrated on disk
			// (ADR-0010, shipped shapes fold forever).
			return {
				...state,
				lastCharacterId:
					"characterId" in event ? event.characterId : state.lastCharacterId,
				lastSeatId: event.seatId,
			};
		}
		case "fake.visit-counted": {
			return { ...state, visits: event.visits };
		}
		case "fake.decision-opened": {
			return {
				...state,
				standing: {
					...state.standing,
					[event.seatId]: {
						answers: event.answers,
						decisionId: event.decisionId,
						kind: event.kind,
						prompt: event.prompt,
					},
				},
			};
		}
		case "fake.decision-answered":
		case "fake.decision-cancelled": {
			if (standingSeatOf(state, event.decisionId) === undefined) {
				return state;
			}
			return {
				...state,
				standing: Object.fromEntries(
					Object.entries(state.standing).filter(
						([, decision]) => decision.decisionId !== event.decisionId
					)
				),
			};
		}
		// Unknown runtime events are skipped for forward compatibility.
		// No default
	}
	return state;
};

/** Where eligibility rules live (ADR-0036): one pure projection the authority
 * and the render side both read. `table.actor` is the perspective (ADR-0002).
 *
 * The standing-decision gate: when the perspective seat has a standing
 * decision, its offer list collapses to answering or declining it (ADR-0035).
 * Outside the gate, a `blocked` offer exists so a Panel can show a disabled
 * action with a reason instead of hiding it. An offer is eligibility computed
 * at render time, never a guarantee: `decide` may still reject it. */
export const offers = (
	state: Readonly<FakeState>,
	table: TableView
): readonly Offer<FakeCommand>[] => {
	const seatId = seatOfActor(table);
	if (seatId === undefined) {
		return [];
	}
	const standing = state.standing[seatId];
	if (standing !== undefined) {
		return [
			{
				availability: "needsSelection",
				label: `Answer: ${standing.prompt}`,
				template: {
					decisionId: standing.decisionId,
					type: "fake.decision.answer",
				},
			},
			{
				availability: "attemptable",
				command: {
					decisionId: standing.decisionId,
					type: "fake.decision.cancel",
				},
				label: "Decline the standing decision",
			},
		];
	}
	return [
		{
			availability: "attemptable",
			command: { seatId, type: "fake.visit" },
			label: "Visit the table",
		},
		{
			availability: "attemptable",
			command: { seatId, type: "fake.pledge" },
			label: "Pledge a double visit",
		},
		{
			availability: "blocked",
			label: "Pledge for another seat",
			reason: PLEDGE_OWN_SEAT_REASON,
		},
	];
};
