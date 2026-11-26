import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	FfChecked,
	FfFiguresAdded,
	FfMapCleared,
	FfMapLoaded,
	FfMoved,
	FfOrderEnded,
	FfOrderStarted,
	FfPcJoined,
	FfPlaced,
	FfPlayed,
	FfRemoved,
	FfRoundStarted,
	FfStatSet,
	FfTagSet,
	FfTurnStarted,
	FfUnplayed,
} from "../events/freeform.ts";
import {
	MapGenerationSchema,
	MapGridSchema,
	SquareSchema,
} from "../external/content.ts";
import { Refused } from "../Refused.rejection.ts";
import { FfSheetSchema } from "../rules/freeform/schema.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

export class FfJoinPc extends Domain.Command(
	"ff-pc",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { id: Schema.String, sheet: Schema.optionalKey(FfSheetSchema) },
		events: [FfPcJoined],
		rejects: [Refused],
	},
	{ description: "Bring a character into the party, or load its sheet again." }
) {}

export class FfAddFigures extends Domain.Command(
	"ff-add",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			monster: Schema.String,
			count: Schema.Int,
			sheet: Schema.optionalKey(FfSheetSchema),
		},
		events: [FfFiguresAdded],
		rejects: [Refused],
	},
	{ description: "Add figures from a sheet, numbered when more than one." }
) {}

export class FfPlay extends Domain.Command(
	"ff-play",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			seated: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [FfPlayed],
		rejects: [Refused],
	},
	{ description: "Play a party member." }
) {}

export class FfUnplay extends Domain.Command(
	"ff-unplay",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.optionalKey(Schema.String) },
		events: [FfUnplayed],
		rejects: [Refused],
	},
	{ description: "Stop playing a party member." }
) {}

export class FfStat extends Domain.Command(
	"ff-stat",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			key: Schema.String,
			op: Schema.Literals(["add", "set"]),
			amount: Schema.Int,
		},
		events: [FfStatSet],
		rejects: [Refused],
	},
	{ description: "Change a stat or a resource." }
) {}

export class FfTag extends Domain.Command(
	"ff-tag",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, tag: Schema.String, on: Schema.Boolean },
		events: [FfTagSet],
		rejects: [Refused],
	},
	{ description: "Put a tag on a figure or take one off." }
) {}

export class FfCheck extends Domain.Command(
	"ff-check",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.optionalKey(Schema.String),
			stat: Schema.String,
			dice: Schema.optionalKey(Schema.String),
		},
		events: [FfChecked],
		rejects: [Refused],
	},
	{ description: "Roll a check: dice plus a stat." }
) {}

export class FfLoadMap extends Domain.Command(
	"ff-map",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.optionalKey(Schema.String),
			grid: Schema.optionalKey(MapGridSchema),
			generate: Schema.optionalKey(MapGenerationSchema),
		},
		events: [FfMapCleared, FfMapLoaded],
		rejects: [Refused],
	},
	{ description: "Load a map, or put it away." }
) {}

export class FfPlace extends Domain.Command(
	"ff-place",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, at: SquareSchema },
		events: [FfPlaced],
		rejects: [Refused],
	},
	{ description: "Put a figure on the map." }
) {}

export class FfMove extends Domain.Command(
	"ff-move",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, to: SquareSchema },
		events: [FfMoved],
		rejects: [Refused],
	},
	{ description: "Move a figure." }
) {}

export class FfRemove extends Domain.Command(
	"ff-remove",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String },
		events: [FfRemoved],
		rejects: [Refused],
	},
	{ description: "Take a figure off the table." }
) {}

export class FfStartOrder extends Domain.Command(
	"ff-start",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.Array(Schema.String) },
		events: [FfOrderStarted],
		rejects: [Refused],
	},
	{ description: "Start turns in an order." }
) {}

export class FfNextTurn extends Domain.Command(
	"ff-next",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [FfRoundStarted, FfTurnStarted],
		rejects: [Refused],
	},
	{ description: "End the turn: the next in the order goes." }
) {}

export class FfEndOrder extends Domain.Command(
	"ff-end",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [FfOrderEnded],
		rejects: [Refused],
	},
	{ description: "End the turns." }
) {}

export const FF_COMMANDS = [
	FfJoinPc,
	FfAddFigures,
	FfPlay,
	FfUnplay,
	FfStat,
	FfTag,
	FfCheck,
	FfLoadMap,
	FfPlace,
	FfMove,
	FfRemove,
	FfStartOrder,
	FfNextTurn,
	FfEndOrder,
] as const;

export type FfTableCommand =
	| FfJoinPc
	| FfAddFigures
	| FfPlay
	| FfUnplay
	| FfStat
	| FfTag
	| FfCheck
	| FfLoadMap
	| FfPlace
	| FfMove
	| FfRemove
	| FfStartOrder
	| FfNextTurn
	| FfEndOrder;
