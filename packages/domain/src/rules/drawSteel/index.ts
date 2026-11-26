import { Schema } from "effect";

import type { Module } from "../core/module.ts";
import type { Envelope } from "../engine.ts";
import { apply, formats } from "./apply.ts";
import { commands } from "./commands.ts";
import type { DsCommand } from "./commands.ts";
import { decide } from "./decide.ts";
import { EVENTS, Payloads } from "./events.ts";
import { initial } from "./state.ts";
import type { DrawSteelState } from "./state.ts";

const TurnStarted = Payloads["ds.turn-started"];

const TurnEnded = Payloads["ds.turn-ended"];

const ALWAYS_ROLLED: ReadonlySet<string> = new Set([
	"ds.power-rolled",
	"ds.bled",
	"ds.saved",
	"ds.combat-started",
]);

const rolled = (envelope: Envelope): boolean => {
	if (ALWAYS_ROLLED.has(envelope.type)) {
		return true;
	}

	if (envelope.type === "ds.turn-started") {
		return (
			Schema.is(TurnStarted)(envelope.payload) &&
			(envelope.payload.rolls?.length ?? 0) > 0
		);
	}

	return (
		envelope.type === "ds.turn-ended" &&
		Schema.is(TurnEnded)(envelope.payload) &&
		envelope.payload.saves.length > 0
	);
};

export const drawSteel: Module<"ds", DrawSteelState, DsCommand> = {
	key: "ds",
	ruleset: "draw-steel",
	initial,
	events: EVENTS,
	retractable: EVENTS.filter(
		(t) =>
			t !== "ds.hero-claimed" && t !== "ds.hero-released" && t !== "ds.measured"
	),
	rolled,
	formats,
	commands,
	decide: (slice, shared, actor, command, dice) =>
		decide(slice, actor, command, dice, shared),
	apply,
};

export {
	completeWho,
	type DsCommand,
	dsFillHostFact,
	dsHostNeed,
} from "./commands.ts";

export {
	checkHeroSheet,
	checkStatBlock,
	decodeHeroSheet,
	decodeStatBlock,
	HeroSheetSchema,
	type SheetProblem,
	sheetProblems,
	StatBlockSchema,
} from "./schema.ts";

export type {
	Ability,
	Characteristic,
	Characteristics,
	DamageModifier,
	HeroSheet,
	Organization,
	StatBlock,
} from "./sheets.ts";

export {
	type Combat,
	type Condition,
	type ConditionName,
	CONDITIONS,
	type Creature,
	type DrawSteelState,
	type Duration,
	type Board,
	type Hero,
	type Side,
} from "./state.ts";

export {
	type Combatant,
	type CombatView,
	combatView,
	drawSteelPrep,
	dsFightLines,
	dsParty,
	dsResyncLines,
	sheetText,
	tokenActions,
	withHeroes,
} from "./view.ts";

export {
	checkGrid,
	columnLabel,
	distance,
	formatSquare,
	MAP_HEIGHT,
	MAP_KINDS,
	MAP_SEED_MAX,
	MAP_WIDTH,
	type MapGeneration,
	type MapGrid,
	type MapKind,
	parseSquare,
	readMapText,
	type Square,
	type Terrain,
	terrainAt,
} from "../board/grid.ts";

export { type MapToken, type MapView, mapView } from "./mapView.ts";

export { marks } from "./state.ts";
