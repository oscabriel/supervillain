export type DsCharacteristic =
	| "might"
	| "agility"
	| "reason"
	| "intuition"
	| "presence";
export const DS_SIDES = ["heroes", "enemies"] as const;
export type DsSide = (typeof DS_SIDES)[number];
export const DS_CONDITIONS = [
	"bleeding",
	"dazed",
	"frightened",
	"grabbed",
	"prone",
	"restrained",
	"slowed",
	"taunted",
	"weakened",
] as const;
export type DsCondition = (typeof DS_CONDITIONS)[number];

export interface DsStatBlock {
	readonly name: string;
	readonly characteristics: Readonly<Record<DsCharacteristic, number>>;
	readonly stamina?: number;
}

export interface DsAbility {
	readonly name: string;
	readonly cost: string | null;
	readonly text: string;
}

export interface DsCharacterSheet {
	readonly name: string;
	readonly ancestry: string;
	readonly className: string;
	readonly kit: string | null;
	readonly characteristics: Readonly<Record<DsCharacteristic, number>>;
	readonly stamina: number;
	readonly recoveries: number;
	readonly heroicResource: string;
	readonly surges: number;
	readonly victories: number;
	readonly abilities: readonly DsAbility[];
}

export interface DsCombatant {
	readonly id: string;
	readonly name: string;
	readonly side: DsSide;
	readonly actedRound: number;
	readonly conditions: readonly DsCondition[];
}

export interface DsPlayState {
	readonly heroicResource: number;
	readonly recoveries: number;
	readonly surges: number;
	readonly victories: number;
}

export interface DsEncounter {
	readonly active: boolean;
	readonly round: number;
	readonly combatants: readonly DsCombatant[];
	readonly lastSide: DsSide | null;
}

export interface DsState {
	readonly characters: readonly DsCharacterSheet[];
	readonly encounter: DsEncounter;
	readonly play: Readonly<Record<string, DsPlayState>>;
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
			readonly type: "ds.apply-condition";
			readonly combatantId: string;
			readonly condition: DsCondition;
	  }
	| {
			readonly type: "ds.remove-condition";
			readonly combatantId: string;
			readonly condition: DsCondition;
	  }
	| {
			readonly type: "ds.gain-resource";
			readonly characterName: string;
			readonly amount: number;
	  }
	| {
			readonly type: "ds.spend-resource";
			readonly characterName: string;
			readonly amount: number;
	  }
	| { readonly type: "ds.spend-recovery"; readonly characterName: string }
	| {
			readonly type: "ds.gain-surges";
			readonly characterName: string;
			readonly count: number;
	  }
	| {
			readonly type: "ds.spend-surges";
			readonly characterName: string;
			readonly count: number;
	  }
	| { readonly type: "ds.gain-victory"; readonly characterName: string }
	| {
			readonly type: "ds.power-roll";
			readonly characteristic: DsCharacteristic;
			readonly edges: number;
			readonly banes: number;
			readonly characterName?: string;
	  };

export type DsEvent =
	| { readonly type: "ds.character-entered"; readonly sheet: DsCharacterSheet }
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
			readonly type: "ds.condition-applied";
			readonly combatantId: string;
			readonly condition: DsCondition;
	  }
	| {
			readonly type: "ds.condition-removed";
			readonly combatantId: string;
			readonly condition: DsCondition;
	  }
	| {
			readonly type: "ds.resource-changed";
			readonly characterName: string;
			readonly delta: number;
			readonly total: number;
	  }
	| {
			readonly type: "ds.recovery-spent";
			readonly characterName: string;
			readonly remaining: number;
	  }
	| {
			readonly type: "ds.surges-changed";
			readonly characterName: string;
			readonly delta: number;
			readonly total: number;
	  }
	| {
			readonly type: "ds.victory-gained";
			readonly characterName: string;
			readonly total: number;
	  }
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

/** Every event type this module's fold recognizes, legacy shapes included —
 * the `statBlock`-shaped `ds.character-entered` is the same recognized type,
 * upgraded on read (ADR-0010). Kept in step with `apply` by the module's own
 * tests; `model.ts` imports nothing, so the entry that registers this module
 * lifts it into an `EventGrammar`. */
export const eventTypes = [
	"ds.character-entered",
	"ds.encounter-started",
	"ds.encounter-ended",
	"ds.combatant-added",
	"ds.turn-taken",
	"ds.round-started",
	"ds.condition-applied",
	"ds.condition-removed",
	"ds.resource-changed",
	"ds.recovery-spent",
	"ds.surges-changed",
	"ds.victory-gained",
	"ds.power-rolled",
] as const satisfies readonly DsEvent["type"][];

const emptyEncounter = (): DsEncounter => ({
	active: false,
	combatants: [],
	lastSide: null,
	round: 0,
});

export const init = (): DsState => ({
	characters: [],
	encounter: emptyEncounter(),
	play: {},
});

export const isRecord = (
	value: unknown
): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasSheet = (
	event: unknown
): event is { readonly sheet: DsCharacterSheet } =>
	isRecord(event) && "sheet" in event;

export const playOf = (
	state: Readonly<DsState>,
	name: string
): DsPlayState | undefined =>
	Object.hasOwn(state.play, name) ? state.play[name] : undefined;

const patchPlay = (
	state: Readonly<DsState>,
	name: string,
	patch: Partial<DsPlayState>
): DsState => {
	const play = playOf(state, name);
	return play === undefined
		? state
		: { ...state, play: { ...state.play, [name]: { ...play, ...patch } } };
};

const mapCombatant = (
	state: Readonly<DsState>,
	combatantId: string,
	fn: (combatant: DsCombatant) => DsCombatant
): DsState => ({
	...state,
	encounter: {
		...state.encounter,
		combatants: state.encounter.combatants.map((combatant) =>
			combatant.id === combatantId ? fn(combatant) : combatant
		),
	},
});

const upgradeStatBlock = (statBlock: DsStatBlock): DsCharacterSheet => ({
	abilities: [],
	ancestry: "",
	characteristics: statBlock.characteristics,
	className: "",
	heroicResource: "",
	kit: null,
	name: statBlock.name,
	recoveries: 0,
	stamina: statBlock.stamina ?? 0,
	surges: 0,
	victories: 0,
});

export const sheetOfEnteredEvent = (
	event: Extract<DsEvent, { readonly type: "ds.character-entered" }>
): DsCharacterSheet => {
	const runtimeEvent: unknown = event;
	return hasSheet(runtimeEvent)
		? runtimeEvent.sheet
		: upgradeStatBlock(
				(runtimeEvent as { readonly statBlock: DsStatBlock }).statBlock
			);
};

// oxlint-disable-next-line eslint/complexity -- branches mirror the pinned event grammar for exhaustive replay folding.
export const apply = (state: Readonly<DsState>, event: DsEvent): DsState => {
	switch (event.type) {
		case "ds.character-entered": {
			const sheetEvent = hasSheet(event);
			const sheet = sheetOfEnteredEvent(event);
			const index = state.characters.findIndex(
				(character) => character.name === sheet.name
			);
			const characters =
				index === -1
					? [...state.characters, sheet]
					: state.characters.map((character, characterIndex) =>
							characterIndex === index ? sheet : character
						);
			if (!sheetEvent) {
				return { ...state, characters };
			}
			const currentPlay = playOf(state, sheet.name);
			const play: DsPlayState =
				currentPlay === undefined
					? {
							heroicResource: 0,
							recoveries: sheet.recoveries,
							surges: sheet.surges,
							victories: sheet.victories,
						}
					: {
							...currentPlay,
							recoveries: Math.min(currentPlay.recoveries, sheet.recoveries),
						};
			return {
				...state,
				characters,
				play: { ...state.play, [sheet.name]: play },
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
						{
							actedRound: 0,
							conditions: [],
							id: event.id,
							name: event.name,
							side: event.side,
						},
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
		case "ds.condition-applied": {
			return mapCombatant(state, event.combatantId, (combatant) => ({
				...combatant,
				conditions: [...combatant.conditions, event.condition],
			}));
		}
		case "ds.condition-removed": {
			return mapCombatant(state, event.combatantId, (combatant) => ({
				...combatant,
				conditions: combatant.conditions.filter(
					(condition) => condition !== event.condition
				),
			}));
		}
		case "ds.resource-changed": {
			return patchPlay(state, event.characterName, {
				heroicResource: event.total,
			});
		}
		case "ds.recovery-spent": {
			return patchPlay(state, event.characterName, {
				recoveries: event.remaining,
			});
		}
		case "ds.surges-changed": {
			return patchPlay(state, event.characterName, { surges: event.total });
		}
		case "ds.victory-gained": {
			return patchPlay(state, event.characterName, { victories: event.total });
		}
		case "ds.power-rolled": {
			return state;
		}
		// Unknown runtime events are skipped for forward compatibility.
		// No default
	}
	return state;
};
