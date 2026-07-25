export interface FakeState {
	readonly visits: number;
	readonly lastSeatId: string | null;
	readonly lastCharacterId: string | null;
}

export type FakeCommand =
	| { readonly type: "fake.visit"; readonly seatId: string }
	| { readonly type: "fake.reject"; readonly reason: string };

export type FakeEvent =
	| {
			readonly type: "fake.seat-observed";
			readonly seatId: string;
			readonly characterId: string | null;
	  }
	| { readonly type: "fake.visit-counted"; readonly visits: number };

/** Every event type this module's fold recognizes, legacy shapes included
 * (ADR-0010). Kept in step with `apply` by the conformance suite; `model.ts`
 * imports nothing, so the entry that registers this module lifts it into an
 * `EventGrammar`. */
export const eventTypes = ["fake.seat-observed", "fake.visit-counted"] as const;

export const init = (): FakeState => ({
	lastCharacterId: null,
	lastSeatId: null,
	visits: 0,
});

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
		// Unknown runtime events are skipped for forward compatibility.
		// No default
	}
	return state;
};
