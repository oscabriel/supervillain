import type { Module } from "../module.ts";
import { apply, formats } from "./apply.ts";
import { commands, type DsCommand } from "./commands.ts";
import { decide } from "./decide.ts";
import { EVENTS } from "./events.ts";
import { type DrawSteelState, initial } from "./state.ts";

/**
 * Draw Steel, the table's second module: the party from hero sheets, creatures and minion squads
 * from stat blocks, combat with sides alternating, Stamina, conditions, power rolls, heroic
 * resources, Malice and hero tokens. Its events are `ds.*`, each carrying its rolls and sheets.
 */
export const drawSteel: Module<"ds", DrawSteelState, DsCommand> = {
  key: "ds",
  initial,
  events: EVENTS,
  formats,
  commands,
  decide: (slice, _shared, actor, command, dice) => decide(slice, actor, command, dice),
  apply,
};

export {
  completeWho,
  type DsCommand,
  type HostFact,
  type HostNeed,
  hostNeeds,
  withHostFact,
} from "./commands.ts";
export {
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
  type Hero,
  type Side,
} from "./state.ts";
export { type Combatant, type CombatView, combatView, sheetText, withHeroes } from "./view.ts";
