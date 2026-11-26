import { Schema } from "effect";

import { parseNotation, signed } from "../../dice.ts";
import {
	cleanText,
	hasControls,
	hasTerminalControls,
	lengthOf,
	looksLikeGuestLabel,
	mixesLatin,
	nameKey,
} from "../../text.ts";
import { decodePayload, isRefused, refuse } from "../engine.ts";
import type { Decision, Dice, Refused } from "../engine.ts";
import { GM } from "./module.ts";
import type { Applied, Module, Shared } from "./module.ts";

export const CHAT_MAX = 500;

export const NAME_MAX = 24;

const STORED_CHAT_MAX = 4 * CHAT_MAX;

const STORED_NAME_MAX = 4 * NAME_MAX;

export type Membership = "in" | "out";

export type Door = "knock" | "open";

export type Admission = "gm" | "invite";

export interface CoreState {
	readonly names: Readonly<Record<string, string>>;
	readonly members: Readonly<Record<string, Membership>>;
	readonly door: Door;
}

export interface AdmitCommand {
	readonly type: "admit";
	readonly who: string;
	readonly member?: string;
	readonly name?: string;
	readonly by?: Admission;
}

export interface NameCommand {
	readonly type: "name";
	readonly name: string;
	readonly seated?: ReadonlyArray<string>;
	readonly cast?: ReadonlyArray<string>;
}

export type CoreCommand =
	| { readonly type: "say"; readonly text: string }
	| { readonly type: "me"; readonly text: string }
	| { readonly type: "narrate"; readonly text: string }
	| NameCommand
	| { readonly type: "roll"; readonly notation: string }
	| AdmitCommand
	| { readonly type: "kick"; readonly who: string }
	| { readonly type: "door"; readonly door: Door };

export const CorePayloads = {
	"core.chat-posted": Schema.Struct({
		text: Schema.String,
		style: Schema.optionalKey(Schema.Literals(["emote", "narration"])),
	}),
	"core.name-set": Schema.Struct({ name: Schema.String }),
	"core.dice-rolled": Schema.Struct({
		notation: Schema.String,
		rolls: Schema.Array(Schema.Int),
		modifier: Schema.Int,
		total: Schema.Int,
	}),
	"core.retracted": Schema.Struct({
		seqs: Schema.NonEmptyArray(Schema.Int),
		undone: Schema.Array(Schema.String),
	}),
	"core.redone": Schema.Struct({ seqs: Schema.NonEmptyArray(Schema.Int) }),
	"core.member-admitted": Schema.Struct({
		member: Schema.String,
		name: Schema.String,
		by: Schema.Literals(["gm", "invite"]),
	}),
	"core.member-removed": Schema.Struct({ member: Schema.String }),
	"core.door-set": Schema.Struct({ door: Schema.Literals(["knock", "open"]) }),
} as const;

export const DOORS: ReadonlyArray<Door> = ["knock", "open"];

const isDoor = (word: string): word is Door =>
	word === "knock" || word === "open";

type ChatStyle = "emote" | "narration";

const COMMON_DICE = ["2d10", "d3", "d6", "d10", "d20", "d100"];

const MARKS = /[()[\]{}↶↷→·]/u;

const SPACES = /\s+/gu;

const SHA256 = /^SHA256:/u;

const chatText = (raw: string): string | Refused => {
	const text = cleanText(raw);

	if (text === "") {
		return refuse("Say something.");
	}

	const length = lengthOf(text);

	if (length > CHAT_MAX) {
		return refuse(`Keep it to ${CHAT_MAX} characters (that was ${length}).`);
	}

	return text;
};

const normalName = (raw: string): string | Refused => {
	const name = raw.normalize("NFKC").replaceAll(SPACES, " ").trim();

	if (name === "") {
		return refuse("Pick a name.");
	}

	if (hasControls(name)) {
		return refuse("Names can't hold control or invisible characters.");
	}

	if (cleanText(name) !== name) {
		return refuse("Names can't hold stray or stacked accents.");
	}

	if (lengthOf(name) > NAME_MAX) {
		return refuse(`Keep names to ${NAME_MAX} characters.`);
	}

	if (mixesLatin(name)) {
		return refuse("Names can't mix Latin letters with another script's.");
	}

	return name;
};

const storedText = (text: string, max: number): boolean =>
	text !== "" && lengthOf(text) <= max && !hasTerminalControls(text);

export const defaultLabel = (actor: string): string => {
	if (actor === GM) {
		return "GM";
	}

	if (actor.startsWith("key:")) {
		return actor.slice(4).replace(SHA256, "").slice(0, 8);
	}

	if (actor.startsWith("guest:")) {
		return `guest-${actor.slice(6, 10)}`;
	}

	return cleanText(actor).slice(0, 12);
};

interface Around {
	readonly seated?: ReadonlyArray<string>;
	readonly cast?: ReadonlyArray<string>;
}

const takenLabels = (
	slice: Pick<CoreState, "names">,
	actors: ReadonlyArray<string>,
	actor: string,
	around: Around
): Set<string> => {
	const { seated = [], cast = [] } = around;

	const others = new Set([
		GM,
		...[...actors, ...Object.keys(slice.names)].filter(
			(a) => !a.startsWith("guest:")
		),
		...seated,
	]);

	others.delete(actor);

	const taken = new Set(cast.map(nameKey));

	for (const other of others) {
		taken.add(nameKey(defaultLabel(other)));

		const name = slice.names[other];

		if (name !== undefined) {
			taken.add(nameKey(name));
		}
	}

	return taken;
};

const nameFor = (
	slice: Pick<CoreState, "names">,
	actors: ReadonlyArray<string>,
	actor: string,
	raw: string,
	around: Around
): string | Refused => {
	const name = normalName(raw);

	if (isRefused(name)) {
		return name;
	}

	if (slice.names[actor] === name) {
		return refuse(`You're already ${name}.`);
	}

	const key = nameKey(name);

	if (takenLabels(slice, actors, actor, around).has(key)) {
		return refuse(`"${name}" is taken; pick another name.`);
	}

	if (MARKS.test(name)) {
		return refuse(`"${name}" would read like a marker; pick another name.`);
	}

	if (looksLikeGuestLabel(name) && key !== nameKey(defaultLabel(actor))) {
		return refuse(`"${name}" looks like a guest's label; pick another name.`);
	}

	return name;
};

const chooseName = (
	slice: CoreState,
	shared: Shared,
	actor: string,
	command: NameCommand
): Decision => {
	const name = nameFor(slice, shared.actors, actor, command.name, command);

	return isRefused(name)
		? name
		: { events: [{ type: "core.name-set", payload: { name } }] };
};

const memberIn = (
	slice: CoreState,
	actors: ReadonlyArray<string>,
	actor: string
) =>
	actor === GM ||
	slice.members[actor] === "in" ||
	(slice.members[actor] !== "out" &&
		(slice.door === "open" || actors.includes(actor)));

const admit = (
	slice: CoreState,
	shared: Shared,
	command: AdmitCommand
): Decision => {
	const { member, name } = command;

	if (member === undefined || name === undefined) {
		return refuse(
			`Nobody called ${JSON.stringify(cleanText(command.who))} is knocking.`
		);
	}

	if (member === GM) {
		return refuse("The GM is always at the table.");
	}

	if (slice.members[member] === "in") {
		return refuse(`${shared.label(member)} is already at the table.`);
	}

	const named =
		slice.names[member] === name
			? name
			: nameFor(slice, shared.actors, member, name, {});

	if (isRefused(named)) {
		return refuse(`Can't let them in as that: ${named.refusal}`);
	}

	return {
		events: [
			{
				type: "core.member-admitted",
				payload: { member, name: named, by: command.by ?? "gm" },
			},
		],
	};
};

const memberNamed = (
	slice: CoreState,
	shared: Shared,
	who: string
): string | undefined => {
	const key = nameKey(who);

	const known = new Set([
		...Object.keys(slice.members),
		...Object.keys(slice.names),
		...shared.actors,
	]);

	known.delete(GM);

	return (
		[...known].find((actor) => actor === who) ??
		[...known].find((actor) => nameKey(shared.label(actor)) === key)
	);
};

const kick = (slice: CoreState, shared: Shared, who: string): Decision => {
	const member = memberNamed(slice, shared, who.trim());

	if (member === undefined) {
		return refuse(
			`Nobody at the table is called ${JSON.stringify(cleanText(who))}.`
		);
	}

	if (!memberIn(slice, shared.actors, member)) {
		return refuse(`${shared.label(member)} isn't at the table.`);
	}

	return { events: [{ type: "core.member-removed", payload: { member } }] };
};

const setDoor = (slice: CoreState, door: Door): Decision =>
	slice.door === door
		? refuse(
				`The door is already ${door === "open" ? "open" : "set to knock"}.`
			)
		: { events: [{ type: "core.door-set", payload: { door } }] };

const DOOR_NOTES = {
	knock: "The door is set to knock: newcomers wait for the GM to let them in.",
	open: "The door is open: anyone who connects sits down.",
} as const satisfies Record<Door, string>;

const sum = (ns: ReadonlyArray<number>): number =>
	ns.reduce((a, b) => a + b, 0);

const roll = (raw: string, dice: Dice): Decision => {
	const notation = parseNotation(raw);

	if (isRefused(notation)) {
		return notation;
	}

	const rolls = Array.from({ length: notation.count }, () =>
		dice(notation.sides)
	);

	for (const face of rolls) {
		if (!Number.isInteger(face) || face < 1 || face > notation.sides) {
			throw new Error(`the dice gave ${face} for a d${notation.sides}`);
		}
	}

	const total = sum(rolls) + notation.modifier;

	const payload = {
		notation: notation.text,
		rolls,
		modifier: notation.modifier,
		total,
	};

	return { events: [{ type: "core.dice-rolled", payload }] };
};

const post = (raw: string, style?: ChatStyle): Decision => {
	const text = chatText(raw);

	if (isRefused(text)) {
		return text;
	}

	const payload = style === undefined ? { text } : { text, style };

	return { events: [{ type: "core.chat-posted", payload }] };
};

const addsUp = (
	p: (typeof CorePayloads)["core.dice-rolled"]["Type"]
): boolean => {
	const notation = parseNotation(p.notation);

	return (
		!isRefused(notation) &&
		notation.text === p.notation &&
		notation.count === p.rolls.length &&
		notation.modifier === p.modifier &&
		p.rolls.every((face) => face >= 1 && face <= notation.sides) &&
		sum(p.rolls) + p.modifier === p.total
	);
};

const wordless = (args: string): boolean => cleanText(args) === "";

export const core: Module<"core", CoreState, CoreCommand> = {
	key: "core",
	initial: { names: {}, members: {}, door: "knock" },
	events: [
		"core.chat-posted",
		"core.name-set",
		"core.dice-rolled",
		"core.member-admitted",
		"core.member-removed",
		"core.door-set",
	],
	retractable: [],
	rolled: () => false,
	formats: {
		chat: { speaker: true, separator: ": " },
		emote: { speaker: true, separator: " " },
		narration: { speaker: false, separator: "" },
		roll: { speaker: true, separator: " " },
		name: { speaker: false, separator: "" },
		member: { speaker: false, separator: "" },
	},
	commands: {
		say: {
			usage: "/say <text>",
			summary: "Say something to the table (plain text does the same).",
			gmOnly: false,
			parse: (args) =>
				wordless(args)
					? refuse("Usage: /say <text>")
					: { type: "say", text: args },
		},
		me: {
			usage: "/me <action>",
			summary: "Act something out: /me waves.",
			gmOnly: false,
			parse: (args) =>
				wordless(args)
					? refuse("Usage: /me <action>")
					: { type: "me", text: args },
		},
		narrate: {
			usage: "/narrate <text>",
			summary: "Describe the scene, with no speaker.",
			gmOnly: true,
			parse: (args) =>
				wordless(args)
					? refuse("Usage: /narrate <text>")
					: { type: "narrate", text: args },
		},
		name: {
			usage: "/name <name>",
			summary: "Set the name the table calls you.",
			gmOnly: false,
			parse: (args) =>
				args.trim() === ""
					? refuse("Usage: /name <name>")
					: { type: "name", name: args },
		},
		roll: {
			usage: "/roll <dice>",
			summary: "Roll dice: 2d10+3, d20, 3d6-1.",
			gmOnly: false,
			parse: (args) => {
				if (args.trim() === "") {
					return refuse("Usage: /roll <dice>, e.g. 2d10+3");
				}

				const notation = parseNotation(args);

				return isRefused(notation)
					? notation
					: { type: "roll", notation: notation.text };
			},
			complete: (_slice, partial) => {
				const typed = partial.trim().toLowerCase();

				return COMMON_DICE.filter((d) => d.startsWith(typed));
			},
		},
		admit: {
			usage: "/admit <who>",
			summary: "Let a player who is knocking sit at the table.",
			gmOnly: true,
			parse: (args) =>
				wordless(args)
					? refuse("Usage: /admit <who>")
					: { type: "admit", who: args.trim() },
		},
		kick: {
			usage: "/kick <who>",
			summary: "Remove a player from the table; they must knock to come back.",
			gmOnly: true,
			parse: (args) =>
				wordless(args)
					? refuse("Usage: /kick <who>")
					: { type: "kick", who: args.trim() },
			complete: (slice, partial) => {
				const typed = nameKey(partial.trim());

				return Object.entries(slice.names)
					.filter(([actor]) => slice.members[actor] !== "out" && actor !== GM)
					.map(([, name]) => name)
					.filter((name) => nameKey(name).startsWith(typed));
			},
		},
		door: {
			usage: "/door knock|open",
			summary:
				"Knock: newcomers wait for you to let them in. Open: anyone who connects sits down.",
			gmOnly: true,
			parse: (args) => {
				const word = args.trim().toLowerCase();

				return isDoor(word)
					? { type: "door", door: word }
					: refuse("Usage: /door knock|open");
			},
			complete: (_slice, partial) => {
				const typed = partial.trim().toLowerCase();

				return DOORS.filter((d) => d.startsWith(typed));
			},
		},
	},
	decide: (slice, shared, actor, command, dice) => {
		switch (command.type) {
			case "say": {
				return post(command.text);
			}

			case "me": {
				return post(command.text, "emote");
			}

			case "narrate": {
				return post(command.text, "narration");
			}

			case "name": {
				return chooseName(slice, shared, actor, command);
			}

			case "roll": {
				return roll(command.notation, dice);
			}

			case "admit": {
				return admit(slice, shared, command);
			}

			case "kick": {
				return kick(slice, shared, command.who);
			}

			case "door": {
				return setDoor(slice, command.door);
			}

			default: {
				return refuse("There is no such command.");
			}
		}
	},
	apply: (slice, envelope): Applied<CoreState> => {
		switch (envelope.type) {
			case "core.chat-posted": {
				const { text, style } = decodePayload(
					CorePayloads["core.chat-posted"],
					envelope
				);

				if (!storedText(text, STORED_CHAT_MAX)) {
					throw new Error(`unsafe chat text at seq ${envelope.seq}`);
				}

				return { slice, feed: { kind: style ?? "chat", text } };
			}

			case "core.name-set": {
				const { name } = decodePayload(CorePayloads["core.name-set"], envelope);

				if (!storedText(name, STORED_NAME_MAX)) {
					throw new Error(
						`bad name ${JSON.stringify(name)} at seq ${envelope.seq}`
					);
				}

				const was = slice.names[envelope.actor];

				return {
					slice: {
						...slice,
						names: { ...slice.names, [envelope.actor]: name },
					},
					feed: {
						kind: "name",
						text:
							was === undefined
								? `${name} joins the table.`
								: `${was} is now ${name}`,
					},
				};
			}

			case "core.dice-rolled": {
				const p = decodePayload(CorePayloads["core.dice-rolled"], envelope);

				if (!addsUp(p)) {
					throw new Error(`the roll at seq ${envelope.seq} doesn't add up`);
				}

				const modifier = p.modifier === 0 ? "" : ` ${signed(p.modifier)}`;
				const text = `rolled ${p.notation}: [${p.rolls.join(", ")}]${modifier} = ${p.total}`;

				return { slice, feed: { kind: "roll", text } };
			}

			case "core.member-admitted": {
				const { member, name } = decodePayload(
					CorePayloads["core.member-admitted"],
					envelope
				);

				if (member === GM || !storedText(name, STORED_NAME_MAX)) {
					throw new Error(
						`bad admission ${JSON.stringify(name)} at seq ${envelope.seq}`
					);
				}

				return {
					slice: {
						...slice,
						names: { ...slice.names, [member]: name },
						members: { ...slice.members, [member]: "in" },
					},
					feed: { kind: "member", text: `${name} joins the table.` },
				};
			}

			case "core.member-removed": {
				const { member } = decodePayload(
					CorePayloads["core.member-removed"],
					envelope
				);

				if (member === GM) {
					throw new Error(`the GM can't be removed, at seq ${envelope.seq}`);
				}

				const name = slice.names[member] ?? defaultLabel(member);

				return {
					slice: { ...slice, members: { ...slice.members, [member]: "out" } },
					feed: { kind: "member", text: `${name} was removed from the table.` },
				};
			}

			case "core.door-set": {
				const { door } = decodePayload(CorePayloads["core.door-set"], envelope);

				return {
					slice: { ...slice, door },
					feed: { kind: "member", text: DOOR_NOTES[door] },
				};
			}

			default: {
				throw new Error(`core can't apply "${envelope.type}"`);
			}
		}
	},
};

interface Named {
	readonly core: Pick<CoreState, "names">;
}

export const labelOf =
	(state: Named) =>
	(actor: string): string =>
		state.core.names[actor] ?? defaultLabel(actor);

export const needsName = (state: Named, actor: string): boolean =>
	actor !== GM && state.core.names[actor] === undefined;

export const nameOf = (state: Named, actor: string): string | undefined =>
	state.core.names[actor];

interface Membered {
	readonly core: CoreState;
	readonly actors: ReadonlyArray<string>;
}

export const isMember = (state: Membered, actor: string): boolean =>
	memberIn(state.core, state.actors, actor);

export const checkName = (
	state: Membered,
	actor: string,
	name: string,
	around: Around = {}
): string | Refused => nameFor(state.core, state.actors, actor, name, around);
