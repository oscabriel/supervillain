import { Effect, Schema } from "effect";

import { CORE_COMMANDS } from "./commands/core.ts";
import { DS_COMMANDS } from "./commands/drawSteel.ts";
import { FF_COMMANDS } from "./commands/freeform.ts";
import { PF_COMMANDS } from "./commands/pf2e.ts";
import { SW_COMMANDS } from "./commands/setWorld.ts";
import { STAGE_COMMANDS } from "./commands/stage.ts";
import { Refused } from "./Refused.rejection.ts";
import { commands } from "./rules/compose.ts";
import type { Command } from "./rules/compose.ts";
import type { RulesetName } from "./Ruleset.ts";
import type { TableCommand } from "./Table.aggregate.ts";
import { commandsFor } from "./table.ts";
import { commandHead } from "./tagged.ts";
import { quote } from "./text.ts";

export const COMMAND_CLASSES = [
	...CORE_COMMANDS,
	...DS_COMMANDS,
	...SW_COMMANDS,
	...PF_COMMANDS,
	...FF_COMMANDS,
	...STAGE_COMMANDS,
] as const;

export type CommandClass = (typeof COMMAND_CLASSES)[number];

const BY_TYPE: ReadonlyMap<string, CommandClass> = new Map(
	COMMAND_CLASSES.map((c) => [c.tag, c] as const)
);

export const commandClassOf = (type: string): CommandClass | undefined =>
	BY_TYPE.get(type);

export const HOST_FACT_KEYS = {
	name: ["seated", "cast"],
	undo: ["whose"],
	admit: ["member", "name", "by"],
	hero: ["sheet"],
	add: ["sheet"],
	play: ["playerActor", "seated"],
	map: ["grid"],
	"set-map": ["grid"],
	"set-recruit": ["character"],
	"set-foe": ["character"],
	"set-play": ["seated"],
	"pf-pc": ["sheet"],
	"pf-add": ["sheet"],
	"pf-play": ["seated"],
	"pf-map": ["grid"],
	"ff-pc": ["sheet"],
	"ff-add": ["sheet"],
	"ff-play": ["seated"],
	"ff-map": ["grid"],
	show: ["card"],
	reveal: ["card"],
	sync: ["cards"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>;

const FACTS: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
	Object.entries(HOST_FACT_KEYS)
);

export const hostFactKeysOf = (type: string): ReadonlyArray<string> =>
	FACTS.get(type) ?? [];

export const commandInputFields = (
	type: string
): Schema.Struct.Fields | undefined => {
	const found = commandClassOf(type);

	if (found === undefined) {
		return undefined;
	}

	const hidden = new Set(["_tag", ...hostFactKeysOf(type)]);

	return Object.fromEntries(
		Object.entries(found.fields).filter(([key]) => !hidden.has(key))
	);
};

const decodeTagged = Schema.decodeUnknownEffect(Schema.Union(COMMAND_CLASSES));

const COMMAND_TYPES: ReadonlySet<string> = new Set(commands.map((c) => c.type));

const isCommand = (value: { readonly type: string }): value is Command =>
	COMMAND_TYPES.has(value.type);

export const commandOfTagged = (tagged: TableCommand): Command | undefined => {
	const { _tag: type, ...rest } = tagged;
	const untagged = { ...rest, type };

	return isCommand(untagged) ? untagged : undefined;
};

const playsHere = (type: string, ruleset: RulesetName | undefined): boolean =>
	ruleset === undefined ||
	commandsFor(ruleset).some((spec) => spec.type === type);

export const commandFromInput = Effect.fn("commandFromInput")(function* (
	type: string,
	input: Schema.JsonObject,
	ruleset?: RulesetName
) {
	const fields = commandInputFields(type);

	if (fields === undefined || !COMMAND_TYPES.has(type)) {
		return yield* new Refused({ message: `There is no "${type}" command.` });
	}

	if (!playsHere(type, ruleset)) {
		return yield* new Refused({
			message: `This table's rules have no "${type}" command.`,
		});
	}

	const misfit = (issue: { readonly message: string }) =>
		new Refused({ message: `That doesn't fit /${type}: ${issue.message}` });

	const extra = Object.keys(input).filter((key) => !Object.hasOwn(fields, key));

	if (extra.length > 0) {
		return yield* misfit({
			message: `it doesn't take ${extra.map((key) => `"${quote(key)}"`).join(", ")}`,
		});
	}

	const tagged = yield* decodeTagged(
		Object.fromEntries([
			...Object.entries(input),
			...Object.entries(commandHead({ type })),
		])
	).pipe(Effect.mapError(misfit));

	const command = commandOfTagged(tagged);

	if (command === undefined) {
		return yield* new Refused({ message: `There is no "${type}" command.` });
	}

	return command;
});
