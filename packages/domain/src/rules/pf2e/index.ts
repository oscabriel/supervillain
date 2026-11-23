import { Schema } from "effect";

import type { Module } from "../core/module.ts";
import type { Envelope } from "../engine.ts";
import { apply, formats } from "./apply.ts";
import { commands } from "./commands.ts";
import type { PfCommand } from "./commands.ts";
import { decide } from "./decide.ts";
import { EVENTS, Payloads } from "./events.ts";
import { initial } from "./state.ts";
import type { PfState } from "./state.ts";

const ALWAYS_ROLLED: ReadonlySet<string> = new Set([
	"pf.initiative-rolled",
	"pf.struck",
	"pf.maneuvered",
	"pf.checked",
	"pf.saved",
	"pf.flat-checked",
	"pf.rerolled",
]);

const rolledPayload = (envelope: Envelope): boolean => {
	const { payload } = envelope;

	if (envelope.type === "pf.turn-started") {
		return (
			Schema.is(Payloads["pf.turn-started"])(payload) &&
			payload.recovery !== undefined
		);
	}

	if (envelope.type === "pf.turn-ended") {
		return (
			Schema.is(Payloads["pf.turn-ended"])(payload) &&
			payload.persistent.length > 0
		);
	}

	if (envelope.type === "pf.cast") {
		return (
			Schema.is(Payloads["pf.cast"])(payload) &&
			payload.results.some(
				(r) =>
					r.natural !== undefined ||
					r.damage !== undefined ||
					r.healed !== undefined
			)
		);
	}

	if (envelope.type === "pf.damaged") {
		return (
			Schema.is(Payloads["pf.damaged"])(payload) &&
			payload.damage.rolls.length > 0
		);
	}

	return (
		envelope.type === "pf.healed" &&
		Schema.is(Payloads["pf.healed"])(payload) &&
		(payload.rolls ?? []).length > 0
	);
};

export const pf2e: Module<"pf", PfState, PfCommand> = {
	key: "pf",
	ruleset: "pf2e",
	initial,
	events: EVENTS,
	retractable: EVENTS.filter(
		(t) =>
			t !== "pf.pc-claimed" && t !== "pf.pc-released" && t !== "pf.measured"
	),
	rolled: (envelope) =>
		ALWAYS_ROLLED.has(envelope.type) || rolledPayload(envelope),
	formats,
	commands,
	decide: (slice, _shared, actor, command, dice) =>
		decide(slice, actor, command, dice),
	apply,
};

export {
	ADD_MAX,
	type PfCommand,
	pfFillHostFact,
	pfHostNeed,
} from "./commands.ts";

export { DamageSchema, MANEUVERS } from "./events.ts";

export {
	adjusted,
	basicDamage,
	budgetFor,
	creatureXp,
	type Degree,
	degree,
	DEGREES,
	mapPenalty,
	type Modifier,
	modifiers,
	parseDamage,
	resolveDamage,
	rollDamage,
	type Threat,
	threatOf,
	THREATS,
} from "./math.ts";

export {
	checkPfSheet,
	decodePfSheet,
	PfCreatureBlockSchema,
	PfHeroSheetSchema,
	type PfSheetProblem,
	pfSheetProblems,
} from "./schema.ts";

export {
	ATTRIBUTES,
	type PfAbility,
	type PfAmount,
	type PfAttribute,
	type PfCreatureBlock,
	type PfHeroSheet,
	type PfSave,
	type PfSheet,
	type PfSize,
	type PfSkill,
	type PfSpell,
	type PfSpells,
	type PfStrike,
	SAVES,
	SIZES,
	SKILLS,
	spaceOf,
} from "./sheets.ts";

export {
	completeCreatures,
	CONDITIONS as PF_CONDITIONS,
	type PfCreature,
	type PfState,
} from "./state.ts";

export {
	crossesOpposite,
	feetOf,
	inReach,
	pfWalk,
	type Parity,
} from "./board.ts";

export {
	encounterXp,
	pfActions,
	pfBand,
	pfMap,
	pfPrep,
	pfSheet,
	sheetLines,
	withPcs,
} from "./view.ts";
