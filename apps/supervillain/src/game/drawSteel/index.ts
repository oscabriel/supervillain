import type { Envelope } from "@supervillain/engine";
import type { Module } from "../module.ts";
import { apply, formats } from "./apply.ts";
import { commands, type DsCommand } from "./commands.ts";
import { decide } from "./decide.ts";
import { EVENTS } from "./events.ts";
import { type DrawSteelState, initial } from "./state.ts";

/**
 * The events that carry dice: power rolls, bleeding, saves, the start of combat, a turn's start that rolls
 * for its resource and a turn's end that rolls saves. A player can't take these back.
 */
function rolled(envelope: Envelope): boolean {
  const payload = envelope.payload as { rolls?: unknown[]; saves?: unknown[] };
  switch (envelope.type) {
    case "ds.power-rolled":
    case "ds.bled":
    case "ds.saved":
    case "ds.combat-started":
      return true;
    case "ds.turn-started":
      return (payload.rolls?.length ?? 0) > 0;
    case "ds.turn-ended":
      return (payload.saves?.length ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * Draw Steel, the table's second module: the party from hero sheets, creatures and minion squads
 * from stat blocks, combat with sides alternating, Stamina, conditions, power rolls, heroic
 * resources, Malice and hero tokens. Its events are `ds.*`, each carrying its rolls and sheets.
 */
export const drawSteel: Module<"ds", DrawSteelState, DsCommand> = {
  key: "ds",
  ruleset: "draw-steel",
  initial,
  events: EVENTS,
  // Every game event /undo may take back, map and tokens included; who plays whom is never
  // undone, and a measurement changes nothing to undo.
  retractable: EVENTS.filter(
    (t) => t !== "ds.hero-claimed" && t !== "ds.hero-released" && t !== "ds.measured",
  ),
  rolled,
  formats,
  commands,
  decide: (slice, shared, actor, command, dice) => decide(slice, actor, command, dice, shared),
  apply,
};

export {
  completeWho,
  type DsCommand,
  type HostFact,
  type HostNeed,
  hostNeeds,
  mapNeed,
  withHostFact,
  withMapGrid,
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
  type Board,
  type Hero,
  type Side,
} from "./state.ts";
export {
  type Combatant,
  type CombatView,
  combatView,
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
  MAP_WIDTH,
  type MapGrid,
  parseSquare,
  readMapText,
  type Square,
  type Terrain,
  terrainAt,
} from "./map.ts";
export { type MapToken, type MapView, mapView } from "./mapView.ts";
export { marks } from "./state.ts";
