import { Effect, Match, Schema } from "effect";

import type { ActorId } from "./Actor.context.ts";
import { COMMAND_CLASSES } from "./commandInput.ts";
import type {
	CardAmbiguous,
	CardNotFound,
	ContentReadError,
	MapInvalid,
	MapNotFound,
	MapWriteFailed,
	SheetAmbiguous,
	SheetInvalid,
	SheetNotFound,
} from "./external/content.ts";
import { Knocks } from "./external/Knocks.external.ts";
import type { Knocker } from "./external/Knocks.external.ts";
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
import { stagedRef } from "./rules/core/stage.ts";
import type { HostFact, HostNeed } from "./rules/hostFacts.ts";
import { hostNeedOf, withHostFact } from "./Ruleset.ts";
import type { TableCommand } from "./Table.aggregate.ts";
import { commandHead } from "./tagged.ts";
import { nameKey, quote } from "./text.ts";

const decodeCommand = Schema.decodeUnknownEffect(Schema.Union(COMMAND_CLASSES));

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

export const namesInPlay = (state: TableState): ReadonlyArray<string> =>
	[
		...state.ds.heroes.map((h) => h.sheet),
		...state.ds.creatures,
		...state.sw.fighters,
		...state.pf.creatures,
		...state.ff.figures,
	].map((w) => w.name);

type ContentError =
	| SheetInvalid
	| SheetNotFound
	| SheetAmbiguous
	| ContentReadError
	| MapNotFound
	| MapInvalid
	| CardNotFound
	| CardAmbiguous;

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
			"ff-hero": ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.ffHero({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "ff-hero", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			"ff-monster": ({ id }): Effect.Effect<HostFact, Refused> =>
				sheets.ffMonster({ query: id }).pipe(
					Effect.map((sheet) => ({ kind: "ff-monster", sheet }) as const),
					Effect.mapError(contentRefusal)
				),
			card: ({ query }): Effect.Effect<HostFact, Refused> =>
				sheets.card({ query }).pipe(
					Effect.map((card) => ({ kind: "card", card }) as const),
					Effect.mapError(contentRefusal)
				),
			cards: ({ ref }): Effect.Effect<HostFact, Refused> => {
				const staged =
					ref === undefined ? undefined : stagedRef(state.stage, ref);

				if (staged !== undefined && "refusal" in staged) {
					return Effect.fail(new Refused({ message: staged.refusal }));
				}

				const keys =
					staged === undefined
						? Object.keys(state.stage.cards)
						: [staged.card.key];

				return sheets.cards({ keys }).pipe(
					Effect.map((cards) => ({ kind: "cards", cards }) as const),
					Effect.mapError(contentRefusal)
				);
			},
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

const FINGERPRINT_STUB = 4;

export const knockersNamed = (
	knockers: ReadonlyArray<Knocker>,
	who: string
): ReadonlyArray<Knocker> => {
	const typed = who.trim();
	const key = nameKey(typed);
	const byActor = knockers.filter((k) => k.actor === typed);

	if (byActor.length > 0) {
		return byActor;
	}

	const byName = knockers.filter((k) => nameKey(k.name) === key);

	if (byName.length > 0) {
		return byName;
	}

	return typed.length >= FINGERPRINT_STUB
		? knockers.filter((k) =>
				k.fingerprint.replace(SHA256, "").startsWith(typed)
			)
		: [];
};

export const knockerNamed = (
	knockers: ReadonlyArray<Knocker>,
	who: string
): Knocker | undefined => {
	const found = knockersNamed(knockers, who);

	return found.length === 1 ? found[0] : undefined;
};

export const ambiguousKnocker = (
	knockers: ReadonlyArray<Knocker>,
	who: string,
	verb: "admit" | "deny" = "admit"
): string | undefined => {
	const found = knockersNamed(knockers, who);
	const [first] = found;

	if (found.length < 2 || first === undefined) {
		return undefined;
	}

	const each = found.map(
		(k) => `${k.name} (${shortFingerprint(k.fingerprint)})`
	);

	return `${found.length} people knocking go by "${quote(who.trim())}": ${each.join(", ")}. Name one by the start of its fingerprint, e.g. /${verb} ${shortFingerprint(first.fingerprint)}.`;
};

export const shortFingerprint = (fingerprint: string): string =>
	fingerprint.replace(SHA256, "").slice(0, 8);

const SHA256 = /^SHA256:/u;

const withSeats = Effect.fn("intake.withSeats")(function* (
	actor: ActorId,
	state: TableState,
	command: Command
) {
	const seating = yield* Seating;

	if (
		command.type === "admit" &&
		actor === GM &&
		command.member === undefined
	) {
		const knocking = yield* (yield* Knocks).pending();
		const ambiguous = ambiguousKnocker(knocking, command.who);

		if (ambiguous !== undefined) {
			return yield* new Refused({ message: ambiguous });
		}

		const found = knockerNamed(knocking, command.who);

		const admitted: Command =
			found === undefined
				? command
				: { ...command, member: found.actor, name: found.name };

		return admitted;
	}

	if (command.type === "name") {
		const seated = yield* seating.here();
		const named: Command = { ...command, seated, cast: namesInPlay(state) };

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
	const seated = yield* withSeats(actor, state, command);

	const filled =
		actor !== GM && GM_ONLY.has(seated.type)
			? seated
			: yield* withFacts(state, seated);

	return yield* toTableCommand(filled);
});
