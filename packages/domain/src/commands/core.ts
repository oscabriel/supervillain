import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	ChatPosted,
	DiceRolled,
	DoorSet,
	MemberAdmitted,
	MemberRemoved,
	NameSet,
	Redone,
	Retracted,
} from "../events/core.ts";
import { Refused } from "../Refused.rejection.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

export class Say extends Domain.Command(
	"say",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { text: Schema.String },
		events: [ChatPosted],
		rejects: [Refused],
	},
	{ description: "Say something to the table." }
) {}

export class Emote extends Domain.Command(
	"me",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { text: Schema.String },
		events: [ChatPosted],
		rejects: [Refused],
	},
	{ description: "Act something out." }
) {}

export class Narrate extends Domain.Command(
	"narrate",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { text: Schema.String },
		events: [ChatPosted],
		rejects: [Refused],
	},
	{ description: "Describe the scene, with no speaker." }
) {}

export class SetName extends Domain.Command(
	"name",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			name: Schema.String,
			seated: Schema.optionalKey(Schema.Array(Schema.String)),
			cast: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [NameSet],
		rejects: [Refused],
	},
	{ description: "Set the name the table calls you." }
) {}

export class Roll extends Domain.Command(
	"roll",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { notation: Schema.String },
		events: [DiceRolled],
		rejects: [Refused],
	},
	{ description: "Roll dice." }
) {}

export class Undo extends Domain.Command(
	"undo",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.optionalKey(Schema.String),
			whose: Schema.optionalKey(Schema.String),
		},
		events: [Retracted],
		rejects: [Refused],
	},
	{
		description:
			"Take back the latest change: a player their own within 30 seconds, the GM anyone's.",
	}
) {}

export class Redo extends Domain.Command(
	"redo",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [Redone],
		rejects: [Refused],
	},
	{ description: "Put back what the latest undo took, with the same dice." }
) {}

export class Admit extends Domain.Command(
	"admit",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			member: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.String),
			by: Schema.optionalKey(Schema.Literals(["gm", "invite"])),
		},
		events: [MemberAdmitted],
		rejects: [Refused],
	},
	{ description: "Let a player who is knocking sit at the table." }
) {}

export class Remove extends Domain.Command(
	"kick",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String },
		events: [MemberRemoved],
		rejects: [Refused],
	},
	{ description: "Remove a player from the table." }
) {}

export class SetDoor extends Domain.Command(
	"door",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { door: Schema.Literals(["knock", "open"]) },
		events: [DoorSet],
		rejects: [Refused],
	},
	{
		description:
			"Set the door: knock makes newcomers wait for the GM, open seats anyone.",
	}
) {}

export const CORE_COMMANDS = [
	Say,
	Emote,
	Narrate,
	SetName,
	Roll,
	Undo,
	Redo,
	Admit,
	Remove,
	SetDoor,
] as const;

export type CoreTableCommand =
	| Say
	| Emote
	| Narrate
	| SetName
	| Roll
	| Undo
	| Redo
	| Admit
	| Remove
	| SetDoor;
