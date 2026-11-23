import { Effect, Match, Schema } from "effect";

import type { ActorId } from "./Actor.context.ts";
import { CORE_COMMANDS } from "./commands/core.ts";
import { DS_COMMANDS } from "./commands/drawSteel.ts";
import { PF_COMMANDS } from "./commands/pf2e.ts";
import { SW_COMMANDS } from "./commands/setWorld.ts";
import type {
	ContentReadError,
	MapInvalid,
	MapNotFound,
	MapWriteFailed,
	SheetAmbiguous,
	SheetInvalid,
	SheetNotFound,
} from "./external/content.ts";
import { MapForge } from "./external/MapForge.external.ts";
import { Seating } from "./external/Seating.external.ts";
import { SetWorld } from "./external/SetWorld.external.ts";
import type { SetWorldError } from "./external/SetWorld.external.ts";
import { Sheets } from "./external/Sheets.external.ts";
import { Refused } from "./Refused.rejection.ts";
import { commands } from "./rules/compose.ts";
import type { Command, TableState } from "./rules/compose.ts";
import { labelOf } from "./rules/core/core.ts";
import { GM } from "./rules/core/module.ts";
import type { HostFact, HostNeed } from "./rules/hostFacts.ts";
import { hostNeedOf, withHostFact } from "./Ruleset.ts";
import type { TableCommand } from "./Table.aggregate.ts";
import { commandHead } from "./tagged.ts";
import { nameKey } from "./text.ts";

const ALL_COMMANDS = [
	...CORE_COMMANDS,
	...DS_COMMANDS,
	...SW_COMMANDS,
	...PF_COMMANDS,
] as const;

const decodeCommand = Schema.decodeUnknownEffect(Schema.Union(ALL_COMMANDS));

const GM_ONLY: ReadonlySet<string> = new Set(
	commands.filter((c) => c.gmOnly).map((c) => c.type)
);

const MOST_NEEDS = 4;

const SENTENCE_END = /[.?!]$/u;

export const toTableCommand = (
	command: Command
): Effect.Effect<TableCommand, Refused> => {
	const { type, ...input } = command;

	return decodeCommand({ ...commandHead({ type }), ...input }).pipe(
		Effect.mapError(
			(issue) =>
				new Refused({ message: `That command doesn't fit: ${issue.message}` })
		)
	);
};

export const actorLabelled = (
	state: TableState,
	seated: ReadonlyArray<string>,
	typed: string
): string | undefined => {
	const label = labelOf(state);
	const key = nameKey(typed);
	const away = [...state.actors, ...Object.keys(state.core.names)];

	const known = [
		...seated,
		...away.filter((actor) => !actor.startsWith("guest:")),
	];

	return known.find((actor) => actor !== GM && nameKey(label(actor)) === key);
};

const inPlay = (state: TableState): ReadonlyArray<string> =>
	[
		...state.ds.heroes.map((h) => h.sheet),
		...state.ds.creatures,
		...state.sw.fighters,
		...state.pf.creatures,
	].map((w) => w.name);

type ContentError =
	| SheetInvalid
	| SheetNotFound
	| SheetAmbiguous
	| ContentReadError
	| MapNotFound
	| MapInvalid;

const contentRefusal = (error: ContentError): Refused =>
	new Refused({
		message: Match.value(error).pipe(
			Match.tag("SheetInvalid", (e) => `${e.file}: ${e.problems.join("; ")}`),
			Match.orElse((e) => e.message)
		),
	});

const forgeRefusal = (kind: string, error: MapWriteFailed): Refused =>
	new Refused({
		message:
			error.reason === "exists"
				? `There's already a map called ${error.id} in maps/: /map ${error.id} loads it.`
				: `Can't make that ${kind}: ${error.message}.`,
	});

const rollRefusal = (error: SetWorldError): Refused =>
	new Refused({
		message: `No roll from set.world for seed ${error.seed}: ${error.message}${SENTENCE_END.test(error.message) ? "" : "."}`,
	});

const factFor = Effect.fn("intake.factFor")(function* (
	state: TableState,
	need: HostNeed
) {
	const sheets = yield* Sheets;
	const seating = yield* Seating;
	const setWorld = yield* SetWorld;
	const forge = yield* MapForge;

	return yield* Match.value(need).pipe(
		Match.discriminatorsExhaustive("kind")({
			hero: ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.hero({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "hero", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			monster: ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.monster({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "monster", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			"pf-hero": ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.pfHero({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "pf-hero", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			"pf-monster": ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.pfMonster({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "pf-monster", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			map: ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.map({ query: id }).pipe(
					Effect.map((found) => ({ kind: "map", ...found }) as const),
					Effect.mapError(contentRefusal)
				),
			generate: ({ generation }): Effect.Effect<HostFact, Refused> =>
				forge
					.generate(
						generation.seed === undefined
							? { kind: generation.kind }
							: { kind: generation.kind, seed: generation.seed }
					)
					.pipe(
						Effect.map(({ id }) => ({ kind: "generated", id }) as const),
						Effect.mapError((failure) => forgeRefusal(generation.kind, failure))
					),
			character: ({ seed }): Effect.Effect<HostFact, Refused> =>
				setWorld.roll(seed === undefined ? {} : { seed }).pipe(
					Effect.map(
						(character) => ({ kind: "character", character }) as const
					),
					Effect.mapError(rollRefusal)
				),
			seated: (): Effect.Effect<HostFact, Refused> =>
				seating
					.here()
					.pipe(Effect.map((seated) => ({ kind: "seated", seated }) as const)),
			player: ({ label }): Effect.Effect<HostFact | undefined, Refused> =>
				seating.here().pipe(
					Effect.map((seated) => {
						const found = actorLabelled(state, seated, label);

						return found === undefined
							? undefined
							: ({ kind: "player", actor: found } as const);
					})
				),
		})
	);
});

const withSeats = Effect.fn("intake.withSeats")(function* (
	state: TableState,
	command: Command
) {
	const seating = yield* Seating;

	if (command.type === "name") {
		const seated = yield* seating.here();
		const named: Command = { ...command, seated, cast: inPlay(state) };

		return named;
	}

	if (command.type === "undo" && command.who !== undefined) {
		const seated = yield* seating.here();

		const whose =
			nameKey(command.who) === nameKey(labelOf(state)(GM))
				? GM
				: actorLabelled(state, seated, command.who);

		const found: Command =
			whose === undefined ? command : { ...command, whose };

		return found;
	}

	return command;
});

const withFacts = Effect.fn("intake.withFacts")(function* (
	state: TableState,
	command: Command
) {
	let current = command;

	for (const _round of Array.from({ length: MOST_NEEDS })) {
		const need = hostNeedOf(current);

		if (need === undefined) {
			return current;
		}

		const fact = yield* factFor(state, need);

		if (fact === undefined) {
			return current;
		}

		current = withHostFact(current, fact);
	}

	return current;
});

export const intake = Effect.fn("intake")(function* (
	actor: ActorId,
	command: Command,
	state: TableState
) {
	const seated = yield* withSeats(state, command);

	const filled =
		actor !== GM && GM_ONLY.has(seated.type)
			? seated
			: yield* withFacts(state, seated);

	return yield* toTableCommand(filled);
});
