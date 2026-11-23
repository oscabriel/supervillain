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

export interface CoreState {
	readonly names: Readonly<Record<string, string>>;
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
	| { readonly type: "roll"; readonly notation: string };

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
} as const;

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

const takenLabels = (
	slice: CoreState,
	shared: Shared,
	actor: string,
	command: NameCommand
): Set<string> => {
	const { seated = [], cast = [] } = command;

	const others = new Set([
		GM,
		...[...shared.actors, ...Object.keys(slice.names)].filter(
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

const chooseName = (
	slice: CoreState,
	shared: Shared,
	actor: string,
	command: NameCommand
): Decision => {
	const name = normalName(command.name);

	if (isRefused(name)) {
		return name;
	}

	if (slice.names[actor] === name) {
		return refuse(`You're already ${name}.`);
	}

	const key = nameKey(name);

	if (takenLabels(slice, shared, actor, command).has(key)) {
		return refuse(`"${name}" is taken; pick another name.`);
	}

	if (MARKS.test(name)) {
		return refuse(`"${name}" would read like a marker; pick another name.`);
	}

	if (looksLikeGuestLabel(name) && key !== nameKey(defaultLabel(actor))) {
		return refuse(`"${name}" looks like a guest's label; pick another name.`);
	}

	return { events: [{ type: "core.name-set", payload: { name } }] };
};

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
	initial: { names: {} },
	events: ["core.chat-posted", "core.name-set", "core.dice-rolled"],
	retractable: [],
	rolled: () => false,
	formats: {
		chat: { speaker: true, separator: ": " },
		emote: { speaker: true, separator: " " },
		narration: { speaker: false, separator: "" },
		roll: { speaker: true, separator: " " },
		name: { speaker: false, separator: "" },
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
					slice: { names: { ...slice.names, [envelope.actor]: name } },
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

			default: {
				throw new Error(`core can't apply "${envelope.type}"`);
			}
		}
	},
};

export const labelOf =
	(state: { readonly core: CoreState }) =>
	(actor: string): string =>
		state.core.names[actor] ?? defaultLabel(actor);

export const needsName = (
	state: { readonly core: CoreState },
	actor: string
): boolean => actor !== GM && state.core.names[actor] === undefined;

export const nameOf = (
	state: { readonly core: CoreState },
	actor: string
): string | undefined => state.core.names[actor];
