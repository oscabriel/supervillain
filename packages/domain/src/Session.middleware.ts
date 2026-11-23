import * as Domain from "@alchemy.run/domain";
import { RpcMiddleware } from "effect/rpc";

import type { CurrentActor } from "./Actor.context.ts";
import type { Entropy } from "./Entropy.context.ts";

export class NotSeated extends Domain.Rejection(
	"NotSeated",
	{},
	{ httpApiStatus: 401 }
) {}

export class Session extends RpcMiddleware.Service<
	Session,
	{ provides: CurrentActor }
>()("Supervillain/Session", { error: NotSeated }) {}

export class Roller extends RpcMiddleware.Service<
	Roller,
	{ provides: Entropy }
>()("Supervillain/Roller") {}
