import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	SwAttacked,
	SwFightEnded,
	SwFightStarted,
	SwFighterClaimed,
	SwFighterJoined,
	SwFighterReleased,
	SwMapCleared,
	SwMapLoaded,
	SwMoved,
	SwPlaced,
	SwTurnBegan,
	SwTurnEnded,
} from "../events/setWorld.ts";
import {
	MapGenerationSchema,
	MapGridSchema,
	SquareSchema,
} from "../external/content.ts";
import { Refused } from "../Refused.rejection.ts";
import { SetCharacterSchema } from "../rules/setWorld/events.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

const RollFields = {
	name: Schema.String,
	seed: Schema.optionalKey(Schema.Int),
	character: Schema.optionalKey(SetCharacterSchema),
};

export class SwLoadMap extends Domain.Command(
	"set-map",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.optionalKey(Schema.String),
			grid: Schema.optionalKey(MapGridSchema),
			generate: Schema.optionalKey(MapGenerationSchema),
		},
		events: [SwMapCleared, SwMapLoaded],
		rejects: [Refused],
	},
	{ description: "Load the fight's map, or put it away." }
) {}

export class SwRecruit extends Domain.Command(
	"set-recruit",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: RollFields,
		events: [SwFighterJoined],
		rejects: [Refused],
	},
	{ description: "Roll a party member at set.world." }
) {}

export class SwFoe extends Domain.Command(
	"set-foe",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: RollFields,
		events: [SwFighterJoined],
		rejects: [Refused],
	},
	{ description: "Roll a foe at set.world." }
) {}

export class SwPlay extends Domain.Command(
	"set-play",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			seated: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [SwFighterClaimed],
		rejects: [Refused],
	},
	{ description: "Play a fighter." }
) {}

export class SwUnplay extends Domain.Command(
	"set-unplay",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.optionalKey(Schema.String) },
		events: [SwFighterReleased],
		rejects: [Refused],
	},
	{ description: "Stop playing a fighter." }
) {}

export class SwPlace extends Domain.Command(
	"set-place",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, at: SquareSchema },
		events: [SwPlaced],
		rejects: [Refused],
	},
	{ description: "Put a fighter on the map." }
) {}

export class SwStartFight extends Domain.Command(
	"set-start",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [SwFightStarted, SwTurnBegan],
		rejects: [Refused],
	},
	{ description: "Start the fight: turns follow initiative." }
) {}

export class SwMove extends Domain.Command(
	"set-move",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, to: SquareSchema },
		events: [SwMoved],
		rejects: [Refused],
	},
	{ description: "Move a fighter." }
) {}

export class SwAttack extends Domain.Command(
	"set-attack",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, target: Schema.String },
		events: [SwAttacked, SwFightEnded],
		rejects: [Refused],
	},
	{ description: "Attack with the main hand." }
) {}

export class SwEndTurn extends Domain.Command(
	"set-done",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [SwFightEnded, SwTurnBegan, SwTurnEnded],
		rejects: [Refused],
	},
	{ description: "End the turn." }
) {}

export class SwEndFight extends Domain.Command(
	"set-end",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [SwFightEnded],
		rejects: [Refused],
	},
	{ description: "End the fight now." }
) {}

export const SW_COMMANDS = [
	SwLoadMap,
	SwRecruit,
	SwFoe,
	SwPlay,
	SwUnplay,
	SwPlace,
	SwStartFight,
	SwMove,
	SwAttack,
	SwEndTurn,
	SwEndFight,
] as const;

export type SwTableCommand =
	| SwLoadMap
	| SwRecruit
	| SwFoe
	| SwPlay
	| SwUnplay
	| SwPlace
	| SwStartFight
	| SwMove
	| SwAttack
	| SwEndTurn
	| SwEndFight;
