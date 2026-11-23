import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

export const ActorId = Schema.String.check(
	Schema.isPattern(/^(?:gm|key:SHA256:\S+|guest:\S+)$/u)
).pipe(Schema.brand("ActorId"));

export type ActorId = typeof ActorId.Type;

export const Role = Schema.Literals(["gm", "player"]);

export type Role = typeof Role.Type;

export const Actor = Schema.Struct({ id: ActorId, role: Role });

export type Actor = typeof Actor.Type;

export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
	"Supervillain/CurrentActor",
	Actor
) {}

export const GM_ID: ActorId = ActorId.make("gm");

export const gmActor: Actor = { id: GM_ID, role: "gm" };

export const playerActor = (id: ActorId): Actor =>
	id === GM_ID ? gmActor : { id, role: "player" };
