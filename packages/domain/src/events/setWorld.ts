import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { Payloads } from "../rules/setWorld/events.ts";

export class SwFighterJoined extends Domain.Event("sw.fighter-joined", {
	actor: ActorId,
	...Payloads["sw.fighter-joined"].fields,
}) {}

export class SwFighterClaimed extends Domain.Event("sw.fighter-claimed", {
	actor: ActorId,
	...Payloads["sw.fighter-claimed"].fields,
}) {}

export class SwFighterReleased extends Domain.Event("sw.fighter-released", {
	actor: ActorId,
	...Payloads["sw.fighter-released"].fields,
}) {}

export class SwMapLoaded extends Domain.Event("sw.map-loaded", {
	actor: ActorId,
	...Payloads["sw.map-loaded"].fields,
}) {}

export class SwMapCleared extends Domain.Event("sw.map-cleared", {
	actor: ActorId,
	...Payloads["sw.map-cleared"].fields,
}) {}

export class SwPlaced extends Domain.Event("sw.placed", {
	actor: ActorId,
	...Payloads["sw.placed"].fields,
}) {}

export class SwMoved extends Domain.Event("sw.moved", {
	actor: ActorId,
	...Payloads["sw.moved"].fields,
}) {}

export class SwFightStarted extends Domain.Event("sw.fight-started", {
	actor: ActorId,
	...Payloads["sw.fight-started"].fields,
}) {}

export class SwTurnBegan extends Domain.Event("sw.turn-began", {
	actor: ActorId,
	...Payloads["sw.turn-began"].fields,
}) {}

export class SwAttacked extends Domain.Event("sw.attacked", {
	actor: ActorId,
	...Payloads["sw.attacked"].fields,
}) {}

export class SwTurnEnded extends Domain.Event("sw.turn-ended", {
	actor: ActorId,
	...Payloads["sw.turn-ended"].fields,
}) {}

export class SwFightEnded extends Domain.Event("sw.fight-ended", {
	actor: ActorId,
	...Payloads["sw.fight-ended"].fields,
}) {}

export const SW_EVENTS = [
	SwFighterJoined,
	SwFighterClaimed,
	SwFighterReleased,
	SwMapLoaded,
	SwMapCleared,
	SwPlaced,
	SwMoved,
	SwFightStarted,
	SwTurnBegan,
	SwAttacked,
	SwTurnEnded,
	SwFightEnded,
] as const;

export type SwEvent =
	| SwFighterJoined
	| SwFighterClaimed
	| SwFighterReleased
	| SwMapLoaded
	| SwMapCleared
	| SwPlaced
	| SwMoved
	| SwFightStarted
	| SwTurnBegan
	| SwAttacked
	| SwTurnEnded
	| SwFightEnded;
