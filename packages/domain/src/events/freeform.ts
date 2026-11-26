import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { Payloads } from "../rules/freeform/events.ts";

export class FfPcJoined extends Domain.Event("ff.pc-joined", {
	actor: ActorId,
	...Payloads["ff.pc-joined"].fields,
}) {}

export class FfFiguresAdded extends Domain.Event("ff.figures-added", {
	actor: ActorId,
	...Payloads["ff.figures-added"].fields,
}) {}

export class FfPlayed extends Domain.Event("ff.played", {
	actor: ActorId,
	...Payloads["ff.played"].fields,
}) {}

export class FfUnplayed extends Domain.Event("ff.unplayed", {
	actor: ActorId,
	...Payloads["ff.unplayed"].fields,
}) {}

export class FfStatSet extends Domain.Event("ff.stat-set", {
	actor: ActorId,
	...Payloads["ff.stat-set"].fields,
}) {}

export class FfTagSet extends Domain.Event("ff.tag-set", {
	actor: ActorId,
	...Payloads["ff.tag-set"].fields,
}) {}

export class FfChecked extends Domain.Event("ff.checked", {
	actor: ActorId,
	...Payloads["ff.checked"].fields,
}) {}

export class FfMapLoaded extends Domain.Event("ff.map-loaded", {
	actor: ActorId,
	...Payloads["ff.map-loaded"].fields,
}) {}

export class FfMapCleared extends Domain.Event("ff.map-cleared", {
	actor: ActorId,
	...Payloads["ff.map-cleared"].fields,
}) {}

export class FfPlaced extends Domain.Event("ff.placed", {
	actor: ActorId,
	...Payloads["ff.placed"].fields,
}) {}

export class FfMoved extends Domain.Event("ff.moved", {
	actor: ActorId,
	...Payloads["ff.moved"].fields,
}) {}

export class FfRemoved extends Domain.Event("ff.removed", {
	actor: ActorId,
	...Payloads["ff.removed"].fields,
}) {}

export class FfOrderStarted extends Domain.Event("ff.order-started", {
	actor: ActorId,
	...Payloads["ff.order-started"].fields,
}) {}

export class FfTurnStarted extends Domain.Event("ff.turn-started", {
	actor: ActorId,
	...Payloads["ff.turn-started"].fields,
}) {}

export class FfRoundStarted extends Domain.Event("ff.round-started", {
	actor: ActorId,
	...Payloads["ff.round-started"].fields,
}) {}

export class FfOrderEnded extends Domain.Event("ff.order-ended", {
	actor: ActorId,
	...Payloads["ff.order-ended"].fields,
}) {}

export const FF_EVENTS = [
	FfPcJoined,
	FfFiguresAdded,
	FfPlayed,
	FfUnplayed,
	FfStatSet,
	FfTagSet,
	FfChecked,
	FfMapLoaded,
	FfMapCleared,
	FfPlaced,
	FfMoved,
	FfRemoved,
	FfOrderStarted,
	FfTurnStarted,
	FfRoundStarted,
	FfOrderEnded,
] as const;

export type FfEvent =
	| FfPcJoined
	| FfFiguresAdded
	| FfPlayed
	| FfUnplayed
	| FfStatSet
	| FfTagSet
	| FfChecked
	| FfMapLoaded
	| FfMapCleared
	| FfPlaced
	| FfMoved
	| FfRemoved
	| FfOrderStarted
	| FfTurnStarted
	| FfRoundStarted
	| FfOrderEnded;
