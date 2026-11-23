import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { Payloads } from "../rules/drawSteel/events.ts";

export class DsHeroJoined extends Domain.Event("ds.hero-joined", {
	actor: ActorId,
	...Payloads["ds.hero-joined"].fields,
}) {}

export class DsHeroClaimed extends Domain.Event("ds.hero-claimed", {
	actor: ActorId,
	...Payloads["ds.hero-claimed"].fields,
}) {}

export class DsHeroReleased extends Domain.Event("ds.hero-released", {
	actor: ActorId,
	...Payloads["ds.hero-released"].fields,
}) {}

export class DsCreaturesAdded extends Domain.Event("ds.creatures-added", {
	actor: ActorId,
	...Payloads["ds.creatures-added"].fields,
}) {}

export class DsCombatStarted extends Domain.Event("ds.combat-started", {
	actor: ActorId,
	...Payloads["ds.combat-started"].fields,
}) {}

export class DsFirstSet extends Domain.Event("ds.first-set", {
	actor: ActorId,
	...Payloads["ds.first-set"].fields,
}) {}

export class DsRoundStarted extends Domain.Event("ds.round-started", {
	actor: ActorId,
	...Payloads["ds.round-started"].fields,
}) {}

export class DsTurnStarted extends Domain.Event("ds.turn-started", {
	actor: ActorId,
	...Payloads["ds.turn-started"].fields,
}) {}

export class DsTurnEnded extends Domain.Event("ds.turn-ended", {
	actor: ActorId,
	...Payloads["ds.turn-ended"].fields,
}) {}

export class DsCombatEnded extends Domain.Event("ds.combat-ended", {
	actor: ActorId,
	...Payloads["ds.combat-ended"].fields,
}) {}

export class DsRested extends Domain.Event("ds.rested", {
	actor: ActorId,
	...Payloads["ds.rested"].fields,
}) {}

export class DsPowerRolled extends Domain.Event("ds.power-rolled", {
	actor: ActorId,
	...Payloads["ds.power-rolled"].fields,
}) {}

export class DsAbilityUsed extends Domain.Event("ds.ability-used", {
	actor: ActorId,
	...Payloads["ds.ability-used"].fields,
}) {}

export class DsBled extends Domain.Event("ds.bled", {
	actor: ActorId,
	...Payloads["ds.bled"].fields,
}) {}

export class DsDamaged extends Domain.Event("ds.damaged", {
	actor: ActorId,
	...Payloads["ds.damaged"].fields,
}) {}

export class DsHealed extends Domain.Event("ds.healed", {
	actor: ActorId,
	...Payloads["ds.healed"].fields,
}) {}

export class DsTempSet extends Domain.Event("ds.temp-set", {
	actor: ActorId,
	...Payloads["ds.temp-set"].fields,
}) {}

export class DsRecovered extends Domain.Event("ds.recovered", {
	actor: ActorId,
	...Payloads["ds.recovered"].fields,
}) {}

export class DsConditionSet extends Domain.Event("ds.condition-set", {
	actor: ActorId,
	...Payloads["ds.condition-set"].fields,
}) {}

export class DsConditionRemoved extends Domain.Event("ds.condition-removed", {
	actor: ActorId,
	...Payloads["ds.condition-removed"].fields,
}) {}

export class DsSaved extends Domain.Event("ds.saved", {
	actor: ActorId,
	...Payloads["ds.saved"].fields,
}) {}

export class DsResourceChanged extends Domain.Event("ds.resource-changed", {
	actor: ActorId,
	...Payloads["ds.resource-changed"].fields,
}) {}

export class DsSurgesChanged extends Domain.Event("ds.surges-changed", {
	actor: ActorId,
	...Payloads["ds.surges-changed"].fields,
}) {}

export class DsMaliceChanged extends Domain.Event("ds.malice-changed", {
	actor: ActorId,
	...Payloads["ds.malice-changed"].fields,
}) {}

export class DsTokensChanged extends Domain.Event("ds.tokens-changed", {
	actor: ActorId,
	...Payloads["ds.tokens-changed"].fields,
}) {}

export class DsTokensReset extends Domain.Event("ds.tokens-reset", {
	actor: ActorId,
	...Payloads["ds.tokens-reset"].fields,
}) {}

export class DsVictoriesChanged extends Domain.Event("ds.victories-changed", {
	actor: ActorId,
	...Payloads["ds.victories-changed"].fields,
}) {}

export class DsMapLoaded extends Domain.Event("ds.map-loaded", {
	actor: ActorId,
	...Payloads["ds.map-loaded"].fields,
}) {}

export class DsMapCleared extends Domain.Event("ds.map-cleared", {
	actor: ActorId,
	...Payloads["ds.map-cleared"].fields,
}) {}

export class DsPlaced extends Domain.Event("ds.placed", {
	actor: ActorId,
	...Payloads["ds.placed"].fields,
}) {}

export class DsMoved extends Domain.Event("ds.moved", {
	actor: ActorId,
	...Payloads["ds.moved"].fields,
}) {}

export class DsForceMoved extends Domain.Event("ds.force-moved", {
	actor: ActorId,
	...Payloads["ds.force-moved"].fields,
}) {}

export class DsMeasured extends Domain.Event("ds.measured", {
	actor: ActorId,
	...Payloads["ds.measured"].fields,
}) {}

export const DS_EVENTS = [
	DsHeroJoined,
	DsHeroClaimed,
	DsHeroReleased,
	DsCreaturesAdded,
	DsCombatStarted,
	DsFirstSet,
	DsRoundStarted,
	DsTurnStarted,
	DsTurnEnded,
	DsCombatEnded,
	DsRested,
	DsPowerRolled,
	DsAbilityUsed,
	DsBled,
	DsDamaged,
	DsHealed,
	DsTempSet,
	DsRecovered,
	DsConditionSet,
	DsConditionRemoved,
	DsSaved,
	DsResourceChanged,
	DsSurgesChanged,
	DsMaliceChanged,
	DsTokensChanged,
	DsTokensReset,
	DsVictoriesChanged,
	DsMapLoaded,
	DsMapCleared,
	DsPlaced,
	DsMoved,
	DsForceMoved,
	DsMeasured,
] as const;

export type DsEvent =
	| DsHeroJoined
	| DsHeroClaimed
	| DsHeroReleased
	| DsCreaturesAdded
	| DsCombatStarted
	| DsFirstSet
	| DsRoundStarted
	| DsTurnStarted
	| DsTurnEnded
	| DsCombatEnded
	| DsRested
	| DsPowerRolled
	| DsAbilityUsed
	| DsBled
	| DsDamaged
	| DsHealed
	| DsTempSet
	| DsRecovered
	| DsConditionSet
	| DsConditionRemoved
	| DsSaved
	| DsResourceChanged
	| DsSurgesChanged
	| DsMaliceChanged
	| DsTokensChanged
	| DsTokensReset
	| DsVictoriesChanged
	| DsMapLoaded
	| DsMapCleared
	| DsPlaced
	| DsMoved
	| DsForceMoved
	| DsMeasured;
