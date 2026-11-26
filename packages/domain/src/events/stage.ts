import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { StagePayloads } from "../rules/core/stage.ts";

export class StageModeSet extends Domain.Event("core.stage-mode-set", {
	actor: ActorId,
	...StagePayloads["core.stage-mode-set"].fields,
}) {}

export class StagePinned extends Domain.Event("core.stage-pinned", {
	actor: ActorId,
	...StagePayloads["core.stage-pinned"].fields,
}) {}

export class StageUnpinned extends Domain.Event("core.stage-unpinned", {
	actor: ActorId,
	...StagePayloads["core.stage-unpinned"].fields,
}) {}

export class CardRevealed extends Domain.Event("core.card-revealed", {
	actor: ActorId,
	...StagePayloads["core.card-revealed"].fields,
}) {}

export class CardHidden extends Domain.Event("core.card-hidden", {
	actor: ActorId,
	...StagePayloads["core.card-hidden"].fields,
}) {}

export class TrackerSet extends Domain.Event("core.tracker-set", {
	actor: ActorId,
	...StagePayloads["core.tracker-set"].fields,
}) {}

export class TrackerRemoved extends Domain.Event("core.tracker-removed", {
	actor: ActorId,
	...StagePayloads["core.tracker-removed"].fields,
}) {}

export class RecapAdded extends Domain.Event("core.recap-added", {
	actor: ActorId,
	...StagePayloads["core.recap-added"].fields,
}) {}

export class ContentSynced extends Domain.Event("core.content-synced", {
	actor: ActorId,
	...StagePayloads["core.content-synced"].fields,
}) {}

export const STAGE_EVENTS = [
	StageModeSet,
	StagePinned,
	StageUnpinned,
	CardRevealed,
	CardHidden,
	TrackerSet,
	TrackerRemoved,
	RecapAdded,
	ContentSynced,
] as const;

export type StageEvent =
	| StageModeSet
	| StagePinned
	| StageUnpinned
	| CardRevealed
	| CardHidden
	| TrackerSet
	| TrackerRemoved
	| RecapAdded
	| ContentSynced;
