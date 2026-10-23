import type { Envelope } from "@supervillain/engine";
import type { Module } from "../module.ts";
import { commands, type SetCommand } from "./commands.ts";
import { EVENTS } from "./events.ts";
import { apply, decide, formats } from "./rules.ts";
import { initial, type SetState } from "./state.ts";

/**
 * set.world, the table's other ruleset (rules.ts states it): fighters rolled at set.world's free
 * API, by seed, then a fight whose turns follow initiative on a logical clock, with Set's stamina,
 * dodge, critical and damage. Its events are `sw.*`, each carrying the roll and the draws.
 */
export const setWorld: Module<"sw", SetState, SetCommand> = {
  key: "sw",
  ruleset: "set-world",
  initial,
  events: EVENTS,
  // Who plays whom is never undone; every other change is.
  retractable: EVENTS.filter((t) => t !== "sw.fighter-claimed" && t !== "sw.fighter-released"),
  rolled: (envelope: Envelope) => envelope.type === "sw.attacked",
  formats,
  commands,
  decide: (slice, _shared, actor, command, dice) => decide(slice, actor, command, dice),
  apply,
};

export { type SetFact, type SetNeed, setNeed, withSetFact } from "./commands.ts";
export { SEED_MAX, SetCharacterSchema } from "./events.ts";
export { landedDamage } from "./rules.ts";
export { completeFighters, type SetCharacter, type SetState, speedOf } from "./state.ts";
export { setActions, setBand, setMap, setSheet, withFighters } from "./view.ts";
export { reachOf } from "./weapons.ts";
