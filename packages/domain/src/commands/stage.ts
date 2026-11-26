import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	CardHidden,
	CardRevealed,
	ContentSynced,
	RecapAdded,
	StageModeSet,
	StagePinned,
	StageUnpinned,
	TrackerRemoved,
	TrackerSet,
} from "../events/stage.ts";
import { Refused } from "../Refused.rejection.ts";
import { StageCardSchema, TRACKER_KINDS } from "../rules/core/stage.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

export class SetStage extends Domain.Command(
	"stage",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { mode: Schema.Literals(["campaign", "encounter", "auto"]) },
		events: [StageModeSet],
		rejects: [Refused],
	},
	{ description: "Show the campaign or the encounter, or follow the fight." }
) {}

export class ShowCard extends Domain.Command(
	"show",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { ref: Schema.String, card: Schema.optionalKey(StageCardSchema) },
		events: [StagePinned],
		rejects: [Refused],
	},
	{ description: "Put a card on the table." }
) {}

export class UnpinCard extends Domain.Command(
	"unpin",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { ref: Schema.String },
		events: [StageUnpinned],
		rejects: [Refused],
	},
	{ description: "Take a card off the table, leaving it in the codex." }
) {}

export class RevealCard extends Domain.Command(
	"reveal",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { ref: Schema.String, card: Schema.optionalKey(StageCardSchema) },
		events: [CardRevealed],
		rejects: [Refused],
	},
	{ description: "Add a card to the players' codex." }
) {}

export class HideCard extends Domain.Command(
	"hide",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { ref: Schema.String },
		events: [CardHidden],
		rejects: [Refused],
	},
	{ description: "Take a card back: GM-only again." }
) {}

export class SetTracker extends Domain.Command(
	"tracker",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.String,
			action: Schema.Literals(["set", "show", "hide", "remove"]),
			kind: Schema.optionalKey(Schema.Literals(TRACKER_KINDS)),
			label: Schema.optionalKey(Schema.String),
			max: Schema.optionalKey(Schema.Int),
			value: Schema.optionalKey(Schema.Int),
		},
		events: [TrackerSet, TrackerRemoved],
		rejects: [Refused],
	},
	{ description: "Set up, show, hide or remove a tracker." }
) {}

export class Tick extends Domain.Command(
	"tick",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.String,
			op: Schema.Literals(["add", "set"]),
			amount: Schema.Int,
		},
		events: [TrackerSet],
		rejects: [Refused],
	},
	{ description: "Move a tracker on." }
) {}

export class AddRecap extends Domain.Command(
	"recap",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { text: Schema.String },
		events: [RecapAdded],
		rejects: [Refused],
	},
	{ description: "Add a line to the session's recap." }
) {}

export class SyncContent extends Domain.Command(
	"sync",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			ref: Schema.optionalKey(Schema.String),
			cards: Schema.optionalKey(Schema.Array(StageCardSchema)),
		},
		events: [ContentSynced],
		rejects: [Refused],
	},
	{ description: "Read the shown cards again from the campaign's files." }
) {}

export const STAGE_COMMANDS = [
	SetStage,
	ShowCard,
	UnpinCard,
	RevealCard,
	HideCard,
	SetTracker,
	Tick,
	AddRecap,
	SyncContent,
] as const;

export type StageTableCommand =
	| SetStage
	| ShowCard
	| UnpinCard
	| RevealCard
	| HideCard
	| SetTracker
	| Tick
	| AddRecap
	| SyncContent;
