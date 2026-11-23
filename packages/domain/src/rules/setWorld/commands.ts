import { ifDefined } from "../../present.ts";
import { quote } from "../../text.ts";
import {
	completeMapArgs,
	MAP_USAGE,
	parseMapArgs,
	parseSquare,
} from "../board/grid.ts";
import type { MapGeneration, MapGrid, Square } from "../board/grid.ts";
import type { CommandSpec, CommandSpecs } from "../core/module.ts";
import type { Refused } from "../engine.ts";
import type { HostFact, HostNeed } from "../hostFacts.ts";
import { SEED_MAX } from "./events.ts";
import { completeFighters, isDown } from "./state.ts";
import type { SetCharacter, SetState } from "./state.ts";

export type SetCommand =
	| {
			readonly type: "set-map";
			readonly id?: string;
			readonly grid?: MapGrid;
			readonly generate?: MapGeneration;
	  }
	| RollCommand<"set-recruit">
	| RollCommand<"set-foe">
	| {
			readonly type: "set-play";
			readonly who: string;
			readonly seated?: ReadonlyArray<string>;
	  }
	| { readonly type: "set-unplay"; readonly who?: string }
	| { readonly type: "set-place"; readonly who: string; readonly at: Square }
	| BareSetCommand<"set-start">
	| { readonly type: "set-move"; readonly who: string; readonly to: Square }
	| {
			readonly type: "set-attack";
			readonly who: string;
			readonly target: string;
	  }
	| BareSetCommand<"set-done">
	| BareSetCommand<"set-end">;

export interface BareSetCommand<
	T extends "set-start" | "set-done" | "set-end",
> {
	readonly type: T;
}

export interface RollCommand<T extends "set-recruit" | "set-foe"> {
	readonly type: T;
	readonly name: string;
	readonly seed?: number;
	readonly character?: SetCharacter;
}

type Spec<T extends SetCommand["type"]> = CommandSpec<
	Extract<SetCommand, { readonly type: T }>,
	SetState
>;

const words = (args: string) =>
	args
		.trim()
		.split(/\s+/u)
		.filter((w) => w !== "");

const usage = (spec: { usage: string }): Refused => ({
	refusal: `Usage: ${spec.usage}`,
});

const notASquare = (typed: string): Refused => ({
	refusal: `'${quote(typed)}' isn't a square like c5.`,
});

const fighterThen =
	(then?: (slice: SetState, typed: string, actor: string) => Array<string>) =>
	(slice: SetState, partial: string, actor: string): Array<string> => {
		const space = partial.search(/\s/u);

		if (space === -1) {
			return completeFighters(slice, partial, actor);
		}

		const who = partial.slice(0, space);
		const typed = partial.slice(space + 1).trimStart();

		return (then?.(slice, typed, actor) ?? []).map((r) => `${who} ${r}`);
	};

const map: Spec<"set-map"> = {
	name: "map",
	usage: MAP_USAGE,
	summary:
		"Load the fight's map from the campaign's maps folder, generate one there, or put it away.",
	gmOnly: true,
	parse: (args) => {
		const parsed = parseMapArgs(args);

		if ("refusal" in parsed) {
			return parsed;
		}

		if (parsed.generate !== undefined) {
			return { type: "set-map", generate: parsed.generate };
		}

		return parsed.id === undefined
			? { type: "set-map" }
			: { type: "set-map", id: parsed.id };
	},
	complete: (_slice, partial) => completeMapArgs(partial),
};

const roll = <T extends "set-recruit" | "set-foe">(
	type: T,
	name: string,
	summary: string
): CommandSpec<RollCommand<T>, SetState> => {
	const spec: CommandSpec<RollCommand<T>, SetState> = {
		name,
		usage: `/${name} <name> [seed]`,
		summary,
		gmOnly: true,
		parse: (args) => {
			const parts = words(args);
			const last = parts.at(-1);

			const seeded =
				parts.length > 1 && last !== undefined && /^\d+$/u.test(last);

			const seed = seeded ? Number(last) : undefined;

			if (seed !== undefined && seed > SEED_MAX) {
				return {
					refusal: `A set.world seed is a whole number from 0 to ${SEED_MAX}.`,
				};
			}

			const named = (seeded ? parts.slice(0, -1) : parts).join(" ");

			if (named === "") {
				return usage(spec);
			}

			return {
				type,
				name: named,
				...ifDefined(seed, (value) => ({ seed: value })),
			};
		},
	};

	return spec;
};

const play: Spec<"set-play"> = {
	name: "play",
	usage: "/play <who>",
	summary: "Play a party member nobody else plays.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		return who === undefined || extra !== undefined
			? usage(play)
			: { type: "set-play", who };
	},
	complete: (slice, partial, actor) =>
		completeFighters(
			slice,
			partial,
			actor,
			(f) => f.side === "party" && f.player === undefined && !isDown(f)
		),
};

const unplay: Spec<"set-unplay"> = {
	name: "unplay",
	usage: "/unplay [who]",
	summary: "Stop playing your fighter. The GM names any fighter to free it.",
	gmOnly: false,
	parse: (args) => {
		const [who, extra] = words(args);

		if (extra !== undefined) {
			return usage(unplay);
		}

		return who === undefined
			? { type: "set-unplay" }
			: { type: "set-unplay", who };
	},
	complete: (slice, partial, actor) =>
		completeFighters(slice, partial, actor, (f) => f.player !== undefined),
};

const place: Spec<"set-place"> = {
	name: "place",
	usage: "/place <who> <square>",
	summary: "Put a fighter on the map at a square like c5.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || typed === undefined || extra !== undefined) {
			return usage(place);
		}

		const at = parseSquare(typed);

		return at === undefined
			? notASquare(typed)
			: { type: "set-place", who, at };
	},
	complete: fighterThen(),
};

const move: Spec<"set-move"> = {
	name: "move",
	usage: "/move <who> <square>",
	summary:
		"Move by the shortest path; in the fight, on its turn and up to its speed.",
	gmOnly: false,
	parse: (args) => {
		const [who, typed, extra] = words(args);

		if (who === undefined || typed === undefined || extra !== undefined) {
			return usage(move);
		}

		const to = parseSquare(typed);

		return to === undefined ? notASquare(typed) : { type: "set-move", who, to };
	},
	complete: fighterThen(),
};

const attack: Spec<"set-attack"> = {
	name: "attack",
	usage: "/attack <who> <target>",
	summary: "Attack once on its turn, for 20 stamina, if its weapon reaches.",
	gmOnly: false,
	parse: (args) => {
		const [who, target, extra] = words(args);

		return who === undefined || target === undefined || extra !== undefined
			? usage(attack)
			: { type: "set-attack", who, target };
	},
	complete: fighterThen((slice, typed, actor) =>
		completeFighters(slice, typed, actor, (f) => !isDown(f))
	),
};

const bare = <T extends "set-start" | "set-done" | "set-end">(
	type: T,
	name: string,
	summary: string,
	gmOnly: boolean
): CommandSpec<BareSetCommand<T>, SetState> => ({
	name,
	usage: `/${name}`,
	summary,
	gmOnly,
	parse: (args) =>
		args.trim() === "" ? { type } : { refusal: `Usage: /${name}` },
});

export const commands: CommandSpecs<SetCommand, SetState> = {
	"set-map": map,
	"set-recruit": roll(
		"set-recruit",
		"recruit",
		"Roll a party member at set.world, by seed or at random."
	),
	"set-foe": roll(
		"set-foe",
		"foe",
		"Roll a foe at set.world, by seed or at random."
	),
	"set-play": play,
	"set-unplay": unplay,
	"set-place": place,
	"set-start": bare(
		"set-start",
		"start",
		"Start the fight: turns follow initiative.",
		true
	),
	"set-move": move,
	"set-attack": attack,
	"set-done": bare(
		"set-done",
		"done",
		"End the turn (a rest, without an attack); the next by initiative begins.",
		false
	),
	"set-end": bare("set-end", "end", "End the fight now.", true),
};

const mapNeed = (
	command: Extract<SetCommand, { readonly type: "set-map" }>
): HostNeed | undefined => {
	if (command.grid !== undefined) {
		return undefined;
	}

	if (command.generate !== undefined) {
		return { kind: "generate", generation: command.generate };
	}

	return command.id === undefined ? undefined : { kind: "map", id: command.id };
};

const isRoll = (
	command: SetCommand
): command is RollCommand<"set-recruit"> | RollCommand<"set-foe"> =>
	command.type === "set-recruit" || command.type === "set-foe";

export const setHostNeed = (command: SetCommand): HostNeed | undefined => {
	if (command.type === "set-map") {
		return mapNeed(command);
	}

	if (isRoll(command) && command.character === undefined) {
		return command.seed === undefined
			? { kind: "character" }
			: { kind: "character", seed: command.seed };
	}

	return command.type === "set-play" && command.seated === undefined
		? { kind: "seated" }
		: undefined;
};

const filledMap = (
	command: Extract<SetCommand, { readonly type: "set-map" }>,
	fact: HostFact
): SetCommand => {
	if (fact.kind === "generated") {
		return { type: "set-map", id: fact.id };
	}

	return fact.kind === "map"
		? { type: "set-map", id: fact.id, grid: fact.grid }
		: command;
};

export const setFillHostFact = (
	command: SetCommand,
	fact: HostFact
): SetCommand => {
	if (command.type === "set-map") {
		return filledMap(command, fact);
	}

	if (isRoll(command) && fact.kind === "character") {
		return { ...command, seed: fact.character.seed, character: fact.character };
	}

	return command.type === "set-play" && fact.kind === "seated"
		? { ...command, seated: fact.seated }
		: command;
};
