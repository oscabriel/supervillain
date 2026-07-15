export type DsCharacteristic =
	| "might"
	| "agility"
	| "reason"
	| "intuition"
	| "presence";
export type DsSide = "heroes" | "enemies";

export interface DsStatBlock {
	readonly name: string;
	readonly characteristics: Readonly<Record<DsCharacteristic, number>>;
	readonly stamina?: number;
}

export interface DsCombatant {
	readonly id: string;
	readonly name: string;
	readonly side: DsSide;
	readonly actedRound: number;
}

export interface DsEncounter {
	readonly active: boolean;
	readonly round: number;
	readonly combatants: readonly DsCombatant[];
	readonly lastSide: DsSide | null;
}

export interface DsState {
	readonly characters: readonly DsStatBlock[];
	readonly encounter: DsEncounter;
}

export type DsCommand =
	| {
			readonly type: "ds.load-character";
			readonly fileName: string;
			readonly text: string;
	  }
	| { readonly type: "ds.start-encounter" }
	| { readonly type: "ds.end-encounter" }
	| {
			readonly type: "ds.add-combatant";
			readonly name: string;
			readonly side: DsSide;
	  }
	| { readonly type: "ds.take-turn"; readonly combatantId: string }
	| {
			readonly type: "ds.power-roll";
			readonly characteristic: DsCharacteristic;
			readonly edges: number;
			readonly banes: number;
			readonly characterName?: string;
	  };

export type DsEvent =
	| { readonly type: "ds.character-entered"; readonly statBlock: DsStatBlock }
	| { readonly type: "ds.encounter-started" }
	| { readonly type: "ds.encounter-ended"; readonly rounds: number }
	| {
			readonly type: "ds.combatant-added";
			readonly id: string;
			readonly name: string;
			readonly side: DsSide;
	  }
	| {
			readonly type: "ds.turn-taken";
			readonly combatantId: string;
			readonly round: number;
	  }
	| { readonly type: "ds.round-started"; readonly round: number }
	| {
			readonly type: "ds.power-rolled";
			readonly characteristic: DsCharacteristic;
			readonly dice: readonly [number, number];
			readonly edges: number;
			readonly banes: number;
			readonly modifier: number;
			readonly total: number;
			readonly tier: 1 | 2 | 3;
			readonly critical: boolean;
			readonly characterName: string | null;
	  };

const emptyEncounter = (): DsEncounter => ({
	active: false,
	combatants: [],
	lastSide: null,
	round: 0,
});

export const init = (): DsState => ({
	characters: [],
	encounter: emptyEncounter(),
});

export const apply = (state: Readonly<DsState>, event: DsEvent): DsState => {
	switch (event.type) {
		case "ds.character-entered": {
			const index = state.characters.findIndex(
				(character) => character.name === event.statBlock.name
			);
			if (index === -1) {
				return { ...state, characters: [...state.characters, event.statBlock] };
			}
			return {
				...state,
				characters: state.characters.map((character, characterIndex) =>
					characterIndex === index ? event.statBlock : character
				),
			};
		}
		case "ds.encounter-started": {
			return {
				...state,
				encounter: { active: true, combatants: [], lastSide: null, round: 1 },
			};
		}
		case "ds.encounter-ended": {
			return { ...state, encounter: emptyEncounter() };
		}
		case "ds.combatant-added": {
			return {
				...state,
				encounter: {
					...state.encounter,
					combatants: [
						...state.encounter.combatants,
						{ actedRound: 0, id: event.id, name: event.name, side: event.side },
					],
				},
			};
		}
		case "ds.turn-taken": {
			const combatant = state.encounter.combatants.find(
				(candidate) => candidate.id === event.combatantId
			);
			return {
				...state,
				encounter: {
					...state.encounter,
					combatants: state.encounter.combatants.map((candidate) =>
						candidate.id === event.combatantId
							? { ...candidate, actedRound: event.round }
							: candidate
					),
					lastSide: combatant?.side ?? state.encounter.lastSide,
				},
			};
		}
		case "ds.round-started": {
			return {
				...state,
				encounter: { ...state.encounter, lastSide: null, round: event.round },
			};
		}
		case "ds.power-rolled": {
			return state;
		}
		// No default
	}
};
