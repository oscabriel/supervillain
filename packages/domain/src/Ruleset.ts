import type { TokenAction } from "./actions.ts";
import type { PrepCatalog, PrepView } from "./prep.ts";
import type { MapGeneration } from "./rules/board/grid.ts";
import { isDsCommand, isPfCommand, isSetCommand } from "./rules/compose.ts";
import type { Command, TableState } from "./rules/compose.ts";
import { labelOf } from "./rules/core/core.ts";
import {
	combatView,
	completeWho,
	drawSteelPrep,
	dsFillHostFact,
	dsHostNeed,
	mapView,
	sheetText,
	tokenActions,
	withHeroes,
} from "./rules/drawSteel/index.ts";
import type { CombatView, MapView } from "./rules/drawSteel/index.ts";
import type { DrawSteelState } from "./rules/drawSteel/state.ts";
import type { Refused } from "./rules/engine.ts";
import type { HostFact, HostNeed } from "./rules/hostFacts.ts";
import {
	completeCreatures,
	pfActions,
	pfBand,
	pfFillHostFact,
	pfHostNeed,
	pfMap,
	pfPrep,
	pfSheet,
	withPcs,
} from "./rules/pf2e/index.ts";
import type { PfState } from "./rules/pf2e/state.ts";
import {
	completeFighters,
	setActions,
	setBand,
	setFillHostFact,
	setHostNeed,
	setMap,
	setSheet,
	setWorldPrep,
	withFighters,
} from "./rules/setWorld/index.ts";
import type { SetState } from "./rules/setWorld/state.ts";

export const RULESET_NAMES = ["draw-steel", "set-world", "pf2e"] as const;

export type RulesetName = (typeof RULESET_NAMES)[number];

export const DEFAULT_RULESET: RulesetName = "draw-steel";

export type TableView = Pick<TableState, "core" | "ds" | "sw" | "pf">;

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
});

export const RULESETS = {
	"draw-steel": drawSteelRuleset,
	"set-world": setWorldRuleset,
	pf2e: pf2eRuleset,
} as const satisfies Record<RulesetName, Ruleset>;

export const rulesetOf = (name: RulesetName): Ruleset => RULESETS[name];

const ALL: ReadonlyArray<Ruleset> = [
	drawSteelRuleset,
	setWorldRuleset,
	pf2eRuleset,
];

export const hostNeedOf = (command: Command): HostNeed | undefined =>
	ALL.map((r) => r.hostNeed(command)).find((need) => need !== undefined);

export const withHostFact = (command: Command, fact: HostFact): Command => {
	let filled = command;

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
