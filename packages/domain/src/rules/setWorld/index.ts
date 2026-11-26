import type { Module } from "../core/module.ts";
import type { Envelope } from "../engine.ts";
import { commands } from "./commands.ts";
import type { SetCommand } from "./commands.ts";
import { EVENTS } from "./events.ts";
import { apply, decide, formats } from "./rules.ts";
import { initial } from "./state.ts";
import type { SetState } from "./state.ts";

export const setWorld: Module<"sw", SetState, SetCommand> = {
	key: "sw",
	ruleset: "set-world",
	initial,
	events: EVENTS,
	retractable: EVENTS.filter(
		(t) => t !== "sw.fighter-claimed" && t !== "sw.fighter-released"
	),
	rolled: (envelope: Envelope) => envelope.type === "sw.attacked",
	formats,
	commands,
	decide: (slice, _shared, actor, command, dice) =>
		decide(slice, actor, command, dice),
	apply,
};

export { decideAutoFoeStep } from "./autoFoe.ts";

export { type SetCommand, setFillHostFact, setHostNeed } from "./commands.ts";

export { SEED_MAX, SetCharacterSchema } from "./events.ts";

export { landedDamage } from "./rules.ts";

export {
	completeFighters,
	type SetCharacter,
	type SetState,
	speedOf,
} from "./state.ts";

export {
	setActions,
	setBand,
	setFightLines,
	setMap,
	setParty,
	setSheet,
	setWorldPrep,
	withFighters,
} from "./view.ts";

export { reachOf } from "./weapons.ts";
