import * as Domain from "@alchemy.run/domain";

import { ActorId } from "../Actor.context.ts";
import { CorePayloads } from "../rules/core/core.ts";

export class ChatPosted extends Domain.Event("core.chat-posted", {
	actor: ActorId,
	...CorePayloads["core.chat-posted"].fields,
}) {}

export class NameSet extends Domain.Event("core.name-set", {
	actor: ActorId,
	...CorePayloads["core.name-set"].fields,
}) {}

export class DiceRolled extends Domain.Event("core.dice-rolled", {
	actor: ActorId,
	...CorePayloads["core.dice-rolled"].fields,
}) {}

export class Retracted extends Domain.Event("core.retracted", {
	actor: ActorId,
	...CorePayloads["core.retracted"].fields,
}) {}

export class Redone extends Domain.Event("core.redone", {
	actor: ActorId,
	...CorePayloads["core.redone"].fields,
}) {}

export const CORE_EVENTS = [
	ChatPosted,
	NameSet,
	DiceRolled,
	Retracted,
	Redone,
] as const;

export type CoreEvent = ChatPosted | NameSet | DiceRolled | Retracted | Redone;
