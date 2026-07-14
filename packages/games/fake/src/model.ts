export interface FakeState {
	readonly visits: number;
	readonly lastSeatId: string | null;
}

export type FakeCommand =
	| { readonly type: "fake.visit"; readonly seatId: string }
	| { readonly type: "fake.reject"; readonly reason: string };

export type FakeEvent =
	| { readonly type: "fake.seat-observed"; readonly seatId: string }
	| { readonly type: "fake.visit-counted"; readonly visits: number };

export const init = (): FakeState => ({ lastSeatId: null, visits: 0 });

export const apply = (
	state: Readonly<FakeState>,
	event: FakeEvent
): FakeState => {
	switch (event.type) {
		case "fake.seat-observed": {
			return { ...state, lastSeatId: event.seatId };
		}
		case "fake.visit-counted": {
			return { ...state, visits: event.visits };
		}
		// No default
	}
};
