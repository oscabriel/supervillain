import type { TokenAction } from "./actions.ts";
import type { EncounterSpec, PartyMember } from "./party.ts";
import type { PrepCatalog, PrepView } from "./prep.ts";
import type { MapGeneration } from "./rules/board/grid.ts";
import {
	isDsCommand,
	isFfCommand,
	isPfCommand,
	isSetCommand,
	isStageCommand,
} from "./rules/compose.ts";
import type { Command, TableState } from "./rules/compose.ts";
import { labelOf } from "./rules/core/core.ts";
import type { CoreState } from "./rules/core/core.ts";
import { stageFillHostFact, stageHostNeed } from "./rules/core/stage.ts";
import {
	combatView,
	completeWho,
	drawSteelPrep,
	dsFightLines,
	dsFillHostFact,
	dsHostNeed,
	dsParty,
	dsResyncLines,
	mapView,
	sheetText,
	tokenActions,
	withHeroes,
} from "./rules/drawSteel/index.ts";
import type { CombatView, MapView } from "./rules/drawSteel/index.ts";
import type { DrawSteelState } from "./rules/drawSteel/state.ts";
import type { Refused } from "./rules/engine.ts";
import {
	ffActions,
	ffBand,
	ffFightLines,
	ffFillHostFact,
	ffHostNeed,
	ffMap,
	ffParty,
	ffPrep,
	ffResyncLines,
	ffSheet,
	completeFigures,
	withFigures,
} from "./rules/freeform/index.ts";
import type { FfState } from "./rules/freeform/state.ts";
import type { HostFact, HostNeed } from "./rules/hostFacts.ts";
import {
	completeCreatures,
	pfActions,
	pfBand,
	pfFightLines,
	pfFillHostFact,
	pfHostNeed,
	pfMap,
	pfParty,
	pfPrep,
	pfResyncLines,
	pfSheet,
	withPcs,
} from "./rules/pf2e/index.ts";
import type { PfState } from "./rules/pf2e/state.ts";
import {
	completeFighters,
	setActions,
	setBand,
	setFightLines,
	setFillHostFact,
	setHostNeed,
	setMap,
	setParty,
	setSheet,
	setWorldPrep,
	withFighters,
} from "./rules/setWorld/index.ts";
import type { SetState } from "./rules/setWorld/state.ts";

export const RULESET_NAMES = [
	"draw-steel",
	"set-world",
	"pf2e",
	"freeform",
] as const;

export type RulesetName = (typeof RULESET_NAMES)[number];

export const DEFAULT_RULESET: RulesetName = "draw-steel";

export type TableView = Pick<TableState, "ds" | "sw" | "pf" | "ff"> & {
	readonly core: Pick<CoreState, "names">;
};

export interface Ruleset {
	readonly name: RulesetName;
	readonly label: (state: TableView) => (actor: string) => string;
	readonly band: (state: TableView, actor: string) => CombatView | undefined;
	readonly map: (state: TableView, actor: string) => MapView | undefined;
	readonly actions: (
		state: TableView,
		actor: string,
		id: string
	) => ReadonlyArray<TokenAction> | undefined;
	readonly prep: (state: TableView, catalog: PrepCatalog) => PrepView;
	readonly sheet: (state: TableView, who: string) => string | Refused;
	readonly completeSheet: (
		state: TableView,
		partial: string,
		actor: string
	) => ReadonlyArray<string>;
	readonly mapGeneration: (command: Command) => MapGeneration | undefined;
	readonly withMapId: (command: Command, id: string) => Command;
	readonly hostNeed: (command: Command) => HostNeed | undefined;
	readonly fillHostFact: (command: Command, fact: HostFact) => Command;
	readonly party: (
		state: TableView,
		actor: string
	) => ReadonlyArray<PartyMember>;
	readonly inCombat: (state: TableView) => boolean;
	readonly fightLines: (encounter: EncounterSpec) => ReadonlyArray<string>;
	readonly resyncLines: (
		state: TableView,
		changed: ReadonlyArray<string>
	) => ReadonlyArray<string>;
}

export interface RulesetImpl<S> {
	readonly name: RulesetName;
	readonly label: (
		slice: S,
		base: (actor: string) => string
	) => (actor: string) => string;
	readonly band: (
		slice: S,
		actor: string,
		base: (actor: string) => string
	) => CombatView | undefined;
	readonly map: (slice: S, actor: string) => MapView | undefined;
	readonly actions: (
		slice: S,
		actor: string,
		id: string
	) => ReadonlyArray<TokenAction> | undefined;
	readonly prep: (slice: S, catalog: PrepCatalog) => PrepView;
	readonly sheet: (slice: S, who: string) => string | Refused;
	readonly completeSheet: (
		slice: S,
		partial: string,
		actor: string
	) => ReadonlyArray<string>;
	readonly hostNeed: (command: Command) => HostNeed | undefined;
	readonly fillHostFact: (command: Command, fact: HostFact) => Command;
	readonly party: (
		slice: S,
		actor: string,
		base: (actor: string) => string
	) => ReadonlyArray<PartyMember>;
	readonly inCombat: (slice: S) => boolean;
	readonly fightLines: (encounter: EncounterSpec) => ReadonlyArray<string>;
	readonly resyncLines: (
		slice: S,
		changed: ReadonlyArray<string>
	) => ReadonlyArray<string>;
}

const generationOf = (need: HostNeed | undefined): MapGeneration | undefined =>
	need?.kind === "generate" ? need.generation : undefined;

export const defineRuleset = <S>(
	slice: (state: TableView) => S,
	impl: RulesetImpl<S>
): Ruleset => ({
	name: impl.name,
	label: (state) => impl.label(slice(state), labelOf(state)),
	band: (state, actor) => impl.band(slice(state), actor, labelOf(state)),
	map: (state, actor) => impl.map(slice(state), actor),
	actions: (state, actor, id) => impl.actions(slice(state), actor, id),
	prep: (state, catalog) => impl.prep(slice(state), catalog),
	sheet: (state, who) => impl.sheet(slice(state), who),
	completeSheet: (state, partial, actor) =>
		impl.completeSheet(slice(state), partial, actor),
	mapGeneration: (command) => generationOf(impl.hostNeed(command)),
	withMapId: (command, id) =>
		generationOf(impl.hostNeed(command)) === undefined
			? command
			: impl.fillHostFact(command, { kind: "generated", id }),
	hostNeed: impl.hostNeed,
	fillHostFact: impl.fillHostFact,
	party: (state, actor) => impl.party(slice(state), actor, labelOf(state)),
	inCombat: (state) => impl.inCombat(slice(state)),
	fightLines: impl.fightLines,
	resyncLines: (state, changed) => impl.resyncLines(slice(state), changed),
});

const drawSteelRuleset = defineRuleset<DrawSteelState>((state) => state.ds, {
	name: "draw-steel",
	label: withHeroes,
	band: combatView,
	map: mapView,
	actions: tokenActions,
	prep: drawSteelPrep,
	sheet: sheetText,
	completeSheet: completeWho,
	hostNeed: (command) =>
		isDsCommand(command) ? dsHostNeed(command) : undefined,
	fillHostFact: (command, fact) =>
		isDsCommand(command) ? dsFillHostFact(command, fact) : command,
	party: dsParty,
	inCombat: (slice) => slice.combat.active,
	fightLines: dsFightLines,
	resyncLines: dsResyncLines,
});

const setWorldRuleset = defineRuleset<SetState>((state) => state.sw, {
	name: "set-world",
	label: withFighters,
	band: setBand,
	map: setMap,
	actions: setActions,
	prep: setWorldPrep,
	sheet: setSheet,
	completeSheet: (slice, partial, actor) =>
		completeFighters(slice, partial, actor),
	hostNeed: (command) =>
		isSetCommand(command) ? setHostNeed(command) : undefined,
	fillHostFact: (command, fact) =>
		isSetCommand(command) ? setFillHostFact(command, fact) : command,
	party: setParty,
	inCombat: (slice) => slice.fight !== undefined,
	fightLines: setFightLines,
	resyncLines: () => [],
});

const pf2eRuleset = defineRuleset<PfState>((state) => state.pf, {
	name: "pf2e",
	label: withPcs,
	band: pfBand,
	map: pfMap,
	actions: pfActions,
	prep: pfPrep,
	sheet: pfSheet,
	completeSheet: (slice, partial, actor) =>
		completeCreatures(slice, partial, actor),
	hostNeed: (command) =>
		isPfCommand(command) ? pfHostNeed(command) : undefined,
	fillHostFact: (command, fact) =>
		isPfCommand(command) ? pfFillHostFact(command, fact) : command,
	party: pfParty,
	inCombat: (slice) => slice.combat !== undefined,
	fightLines: pfFightLines,
	resyncLines: pfResyncLines,
});

const freeformRuleset = defineRuleset<FfState>((state) => state.ff, {
	name: "freeform",
	label: withFigures,
	band: ffBand,
	map: ffMap,
	actions: ffActions,
	prep: ffPrep,
	sheet: ffSheet,
	completeSheet: (slice, partial, actor) =>
		completeFigures(slice, partial, actor),
	hostNeed: (command) =>
		isFfCommand(command) ? ffHostNeed(command) : undefined,
	fillHostFact: (command, fact) =>
		isFfCommand(command) ? ffFillHostFact(command, fact) : command,
	party: ffParty,
	inCombat: (slice) => slice.order !== undefined,
	fightLines: ffFightLines,
	resyncLines: ffResyncLines,
});

export const RULESETS = {
	"draw-steel": drawSteelRuleset,
	"set-world": setWorldRuleset,
	pf2e: pf2eRuleset,
	freeform: freeformRuleset,
} as const satisfies Record<RulesetName, Ruleset>;

export const rulesetOf = (name: RulesetName): Ruleset => RULESETS[name];

const ALL: ReadonlyArray<Ruleset> = [
	drawSteelRuleset,
	setWorldRuleset,
	pf2eRuleset,
	freeformRuleset,
];

export const hostNeedOf = (command: Command): HostNeed | undefined =>
	isStageCommand(command)
		? stageHostNeed(command)
		: ALL.map((r) => r.hostNeed(command)).find((need) => need !== undefined);

export const withHostFact = (command: Command, fact: HostFact): Command => {
	let filled = isStageCommand(command)
		? stageFillHostFact(command, fact)
		: command;

	for (const r of ALL) {
		filled = r.fillHostFact(filled, fact);
	}

	return filled;
};

export const mapGeneration = (command: Command): MapGeneration | undefined =>
	ALL.map((r) => r.mapGeneration(command)).find((g) => g !== undefined);

export const withMapId = (command: Command, id: string): Command => {
	let filled = command;

	for (const r of ALL) {
		filled = r.withMapId(filled, id);
	}

	return filled;
};
