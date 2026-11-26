import type { Module } from "../core/module.ts";
import type { Envelope } from "../engine.ts";
import { apply, formats } from "./apply.ts";
import { commands } from "./commands.ts";
import type { FfCommand } from "./commands.ts";
import { decide } from "./decide.ts";
import { EVENTS } from "./events.ts";
import { initial } from "./state.ts";
import type { FfState } from "./state.ts";

export const freeform: Module<"ff", FfState, FfCommand> = {
	key: "ff",
	ruleset: "freeform",
	initial,
	events: EVENTS,
	retractable: EVENTS.filter((t) => t !== "ff.played" && t !== "ff.unplayed"),
	rolled: (envelope: Envelope) => envelope.type === "ff.checked",
	formats,
	commands,
	decide: (slice, _shared, actor, command, dice) =>
		decide(slice, actor, command, dice),
	apply,
};

export {
	type FfCommand,
	ffFillHostFact,
	ffHostNeed,
	type FfStatOp,
} from "./commands.ts";

export {
	FF_NAME_MAX,
	type FfSheet,
	ffSheetProblem,
	FfSheetSchema,
	STAT_KEY,
	StatKeySchema,
	StatsSchema,
	TAG,
} from "./schema.ts";

export {
	actingId,
	ADD_MAX as FF_ADD_MAX,
	completeFigures,
	type FfFigure,
	type FfOrder,
	type FfState,
} from "./state.ts";

export {
	ffActions,
	ffBand,
	ffFightLines,
	ffMap,
	ffParty,
	ffPrep,
	ffResyncLines,
	ffSheet,
	ffSheetLines,
	withFigures,
} from "./view.ts";
