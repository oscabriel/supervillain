import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { Payloads } from "../rules/pf2e/events.ts";

export class PfPcJoined extends Domain.Event("pf.pc-joined", {
	actor: ActorId,
	...Payloads["pf.pc-joined"].fields,
}) {}

export class PfCreaturesAdded extends Domain.Event("pf.creatures-added", {
	actor: ActorId,
	...Payloads["pf.creatures-added"].fields,
}) {}

export class PfPcClaimed extends Domain.Event("pf.pc-claimed", {
	actor: ActorId,
	...Payloads["pf.pc-claimed"].fields,
}) {}

export class PfPcReleased extends Domain.Event("pf.pc-released", {
	actor: ActorId,
	...Payloads["pf.pc-released"].fields,
}) {}

export class PfInitiativeRolled extends Domain.Event("pf.initiative-rolled", {
	actor: ActorId,
	...Payloads["pf.initiative-rolled"].fields,
}) {}

export class PfCombatStarted extends Domain.Event("pf.combat-started", {
	actor: ActorId,
	...Payloads["pf.combat-started"].fields,
}) {}

export class PfTurnStarted extends Domain.Event("pf.turn-started", {
	actor: ActorId,
	...Payloads["pf.turn-started"].fields,
}) {}

export class PfTurnEnded extends Domain.Event("pf.turn-ended", {
	actor: ActorId,
	...Payloads["pf.turn-ended"].fields,
}) {}

export class PfDelayed extends Domain.Event("pf.delayed", {
	actor: ActorId,
	...Payloads["pf.delayed"].fields,
}) {}

export class PfRejoined extends Domain.Event("pf.rejoined", {
	actor: ActorId,
	...Payloads["pf.rejoined"].fields,
}) {}

export class PfCombatEnded extends Domain.Event("pf.combat-ended", {
	actor: ActorId,
	...Payloads["pf.combat-ended"].fields,
}) {}

export class PfStruck extends Domain.Event("pf.struck", {
	actor: ActorId,
	...Payloads["pf.struck"].fields,
}) {}

export class PfMoved extends Domain.Event("pf.moved", {
	actor: ActorId,
	...Payloads["pf.moved"].fields,
}) {}

export class PfPlaced extends Domain.Event("pf.placed", {
	actor: ActorId,
	...Payloads["pf.placed"].fields,
}) {}

export class PfMapLoaded extends Domain.Event("pf.map-loaded", {
	actor: ActorId,
	...Payloads["pf.map-loaded"].fields,
}) {}

export class PfMapCleared extends Domain.Event("pf.map-cleared", {
	actor: ActorId,
	...Payloads["pf.map-cleared"].fields,
}) {}

export class PfMeasured extends Domain.Event("pf.measured", {
	actor: ActorId,
	...Payloads["pf.measured"].fields,
}) {}

export class PfStood extends Domain.Event("pf.stood", {
	actor: ActorId,
	...Payloads["pf.stood"].fields,
}) {}

export class PfDroppedProne extends Domain.Event("pf.dropped-prone", {
	actor: ActorId,
	...Payloads["pf.dropped-prone"].fields,
}) {}

export class PfShieldRaised extends Domain.Event("pf.shield-raised", {
	actor: ActorId,
	...Payloads["pf.shield-raised"].fields,
}) {}

export class PfShieldBlocked extends Domain.Event("pf.shield-blocked", {
	actor: ActorId,
	...Payloads["pf.shield-blocked"].fields,
}) {}

export class PfManeuvered extends Domain.Event("pf.maneuvered", {
	actor: ActorId,
	...Payloads["pf.maneuvered"].fields,
}) {}

export class PfChecked extends Domain.Event("pf.checked", {
	actor: ActorId,
	...Payloads["pf.checked"].fields,
}) {}

export class PfSaved extends Domain.Event("pf.saved", {
	actor: ActorId,
	...Payloads["pf.saved"].fields,
}) {}

export class PfFlatChecked extends Domain.Event("pf.flat-checked", {
	actor: ActorId,
	...Payloads["pf.flat-checked"].fields,
}) {}

export class PfCast extends Domain.Event("pf.cast", {
	actor: ActorId,
	...Payloads["pf.cast"].fields,
}) {}

export class PfDamaged extends Domain.Event("pf.damaged", {
	actor: ActorId,
	...Payloads["pf.damaged"].fields,
}) {}

export class PfHealed extends Domain.Event("pf.healed", {
	actor: ActorId,
	...Payloads["pf.healed"].fields,
}) {}

export class PfTempSet extends Domain.Event("pf.temp-set", {
	actor: ActorId,
	...Payloads["pf.temp-set"].fields,
}) {}

export class PfConditionSet extends Domain.Event("pf.condition-set", {
	actor: ActorId,
	...Payloads["pf.condition-set"].fields,
}) {}

export class PfConditionRemoved extends Domain.Event("pf.condition-removed", {
	actor: ActorId,
	...Payloads["pf.condition-removed"].fields,
}) {}

export class PfPersistentSet extends Domain.Event("pf.persistent-set", {
	actor: ActorId,
	...Payloads["pf.persistent-set"].fields,
}) {}

export class PfPersistentRemoved extends Domain.Event("pf.persistent-removed", {
	actor: ActorId,
	...Payloads["pf.persistent-removed"].fields,
}) {}

export class PfHeroPointsSet extends Domain.Event("pf.hero-points-set", {
	actor: ActorId,
	...Payloads["pf.hero-points-set"].fields,
}) {}

export class PfRerolled extends Domain.Event("pf.rerolled", {
	actor: ActorId,
	...Payloads["pf.rerolled"].fields,
}) {}

export class PfHeroicRecovery extends Domain.Event("pf.heroic-recovery", {
	actor: ActorId,
	...Payloads["pf.heroic-recovery"].fields,
}) {}

export class PfRested extends Domain.Event("pf.rested", {
	actor: ActorId,
	...Payloads["pf.rested"].fields,
}) {}

export const PF_EVENTS = [
	PfPcJoined,
	PfCreaturesAdded,
	PfPcClaimed,
	PfPcReleased,
	PfInitiativeRolled,
	PfCombatStarted,
	PfTurnStarted,
	PfTurnEnded,
	PfDelayed,
	PfRejoined,
	PfCombatEnded,
	PfStruck,
	PfMoved,
	PfPlaced,
	PfMapLoaded,
	PfMapCleared,
	PfMeasured,
	PfStood,
	PfDroppedProne,
	PfShieldRaised,
	PfShieldBlocked,
	PfManeuvered,
	PfChecked,
	PfSaved,
	PfFlatChecked,
	PfCast,
	PfDamaged,
	PfHealed,
	PfTempSet,
	PfConditionSet,
	PfConditionRemoved,
	PfPersistentSet,
	PfPersistentRemoved,
	PfHeroPointsSet,
	PfRerolled,
	PfHeroicRecovery,
	PfRested,
] as const;

export type PfEvent =
	| PfPcJoined
	| PfCreaturesAdded
	| PfPcClaimed
	| PfPcReleased
	| PfInitiativeRolled
	| PfCombatStarted
	| PfTurnStarted
	| PfTurnEnded
	| PfDelayed
	| PfRejoined
	| PfCombatEnded
	| PfStruck
	| PfMoved
	| PfPlaced
	| PfMapLoaded
	| PfMapCleared
	| PfMeasured
	| PfStood
	| PfDroppedProne
	| PfShieldRaised
	| PfShieldBlocked
	| PfManeuvered
	| PfChecked
	| PfSaved
	| PfFlatChecked
	| PfCast
	| PfDamaged
	| PfHealed
	| PfTempSet
	| PfConditionSet
	| PfConditionRemoved
	| PfPersistentSet
	| PfPersistentRemoved
	| PfHeroPointsSet
	| PfRerolled
	| PfHeroicRecovery
	| PfRested;
