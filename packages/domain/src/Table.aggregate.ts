import * as Domain from "@alchemy.run/domain";
import { DateTime, Effect, Schema } from "effect";

import { CurrentActor } from "./Actor.context.ts";
import {
	CORE_COMMANDS,
	Emote,
	Narrate,
	Redo,
	Roll,
	Say,
	SetName,
	Undo,
} from "./commands/core.ts";
import type { CoreTableCommand } from "./commands/core.ts";
import {
	DS_COMMANDS,
	DsAddCreatures,
	DsCondition,
	DsDamage,
	DsEndCombat,
	DsEndTurn,
	DsFreeStrike,
	DsHeal,
	DsJoinHero,
	DsLoadMap,
	DsMalice,
	DsMeasure,
	DsMove,
	DsNextRound,
	DsPlace,
	DsPlay,
	DsPowerRoll,
	DsPull,
	DsPush,
	DsRecover,
	DsResource,
	DsRest,
	DsSave,
	DsSetFirst,
	DsSetTemp,
	DsSlide,
	DsStartCombat,
	DsSurge,
	DsTakeTurn,
	DsToken,
	DsUnplay,
	DsVictory,
} from "./commands/drawSteel.ts";
import type { DsTableCommand } from "./commands/drawSteel.ts";
import {
	PfAddCreatures,
	PfBlock,
	PfCastSpell,
	PfCheck,
	PfCondition,
	PfCrawl,
	PfDamage,
	PfDelay,
	PfDemoralize,
	PfDisarm,
	PfDrop,
	PfEndEncounter,
	PfEndTurn,
	PfFlat,
	PfGrapple,
	PfHeal,
	PfHeroPoints,
	PfJoin,
	PfJoinPc,
	PfLoadMap,
	PfMeasure,
	PfMove,
	PfPlace,
	PfPlay,
	PfRaiseShield,
	PfRecover,
	PfReroll,
	PfRest,
	PfRollInitiative,
	PfSave,
	PfSetTemp,
	PfShove,
	PfStand,
	PfStartEncounter,
	PfStep,
	PfStride,
	PfStrike,
	PfTakeTurn,
	PfTrip,
	PfUnplay,
	PF_COMMANDS,
} from "./commands/pf2e.ts";
import type { PfTableCommand } from "./commands/pf2e.ts";
import {
	SW_COMMANDS,
	SwAttack,
	SwEndFight,
	SwEndTurn,
	SwFoe,
	SwLoadMap,
	SwMove,
	SwPlace,
	SwPlay,
	SwRecruit,
	SwStartFight,
	SwUnplay,
} from "./commands/setWorld.ts";
import type { SwTableCommand } from "./commands/setWorld.ts";
import { diceOf, Entropy } from "./Entropy.context.ts";
import type { CoreEvent } from "./events/core.ts";
import type { DsEvent } from "./events/drawSteel.ts";
import type { PfEvent } from "./events/pf2e.ts";
import type { SwEvent } from "./events/setWorld.ts";
import { Refused } from "./Refused.rejection.ts";
import { initial, rules } from "./rules/compose.ts";
import type { Command, TableState } from "./rules/compose.ts";
import { isRefused } from "./rules/engine.ts";
import type { Envelope } from "./rules/engine.ts";
import { TableId } from "./Table.id.ts";
import { TableStateSchema } from "./TableState.ts";
import { eventHead } from "./tagged.ts";

export type TableEvent = CoreEvent | DsEvent | SwEvent | PfEvent;

export type TableCommand =
	| CoreTableCommand
	| DsTableCommand
	| SwTableCommand
	| PfTableCommand;

export const envelopeOf = (
	event: TableEvent,
	seq: number,
	timestamp: string
): Envelope => {
	const { _tag: type, actor, ...payload } = event;

	return { actor, seq, timestamp, type, payload };
};

export const toEnvelope = (
	event: TableEvent,
	envelope: Domain.Aggregate.Envelope<TableId>
): Envelope => envelopeOf(event, envelope.seq, DateTime.formatIso(envelope.at));

const fold = (
	state: TableState,
	event: TableEvent,
	envelope: Domain.Aggregate.Envelope<TableId>
): TableState => rules.apply(state, toEnvelope(event, envelope));

export const asCommand = <I extends TableCommand>(
	input: I
): { readonly type: I["_tag"] } & Omit<I, "_tag"> => {
	const { _tag: type, ...rest } = input;

	return { type, ...rest };
};

type DecodedEvent = Domain.Event.Any & Schema.Decoder<unknown>;

const decides = <
	C extends Domain.Command.Any & {
		readonly events: ReadonlyArray<DecodedEvent>;
	},
>(
	command: C,
	toCommand: (input: Domain.Aggregate.InstanceOf<C>) => Command
) => {
	const events: C["events"] = command.events;
	const decode = Schema.decodeUnknownEffect(Schema.Union(events));

	return (
		state: TableState,
		input: Domain.Aggregate.InstanceOf<C>,
		context: { readonly now: DateTime.Utc }
	): Effect.Effect<
		ReadonlyArray<Schema.Union<C["events"]>["Type"]>,
		Refused,
		CurrentActor | Entropy
	> =>
		Effect.gen(function* () {
			const { id } = yield* CurrentActor;
			const { seed } = yield* Entropy;

			const decision = rules.decide(
				state,
				id,
				toCommand(input),
				diceOf(seed),
				DateTime.toEpochMillis(context.now)
			);

			if (isRefused(decision)) {
				return yield* new Refused({ message: decision.refusal });
			}

			return yield* Effect.forEach(
				decision.events,
				(event) =>
					decode({
						...event.payload,
						...eventHead({ type: event.type, actor: id }),
					}),
				{ concurrency: 1 }
			).pipe(Effect.orDie);
		}).pipe(Effect.withSpan("Table.decide"));
};

export class Table extends Domain.Aggregate(
	"Table",
	{
		id: TableId,
		state: TableStateSchema,
		initial,
		commands: [
			...CORE_COMMANDS,
			...DS_COMMANDS,
			...SW_COMMANDS,
			...PF_COMMANDS,
		],
		decide: {
			say: decides(Say, asCommand),
			me: decides(Emote, asCommand),
			narrate: decides(Narrate, asCommand),
			name: decides(SetName, asCommand),
			roll: decides(Roll, asCommand),
			undo: decides(Undo, asCommand),
			redo: decides(Redo, asCommand),
			hero: decides(DsJoinHero, asCommand),
			add: decides(DsAddCreatures, asCommand),
			play: decides(DsPlay, asCommand),
			unplay: decides(DsUnplay, asCommand),
			start: decides(DsStartCombat, asCommand),
			first: decides(DsSetFirst, asCommand),
			turn: decides(DsTakeTurn, asCommand),
			done: decides(DsEndTurn, asCommand),
			round: decides(DsNextRound, asCommand),
			end: decides(DsEndCombat, asCommand),
			rest: decides(DsRest, asCommand),
			pr: decides(DsPowerRoll, asCommand),
			dmg: decides(DsDamage, asCommand),
			fs: decides(DsFreeStrike, asCommand),
			heal: decides(DsHeal, asCommand),
			temp: decides(DsSetTemp, asCommand),
			recover: decides(DsRecover, asCommand),
			cond: decides(DsCondition, asCommand),
			save: decides(DsSave, asCommand),
			res: decides(DsResource, asCommand),
			surge: decides(DsSurge, asCommand),
			malice: decides(DsMalice, asCommand),
			token: decides(DsToken, asCommand),
			victory: decides(DsVictory, asCommand),
			map: decides(DsLoadMap, asCommand),
			place: decides(DsPlace, asCommand),
			move: decides(DsMove, asCommand),
			dist: decides(DsMeasure, asCommand),
			push: decides(DsPush, asCommand),
			pull: decides(DsPull, asCommand),
			slide: decides(DsSlide, asCommand),
			"set-map": decides(SwLoadMap, asCommand),
			"set-recruit": decides(SwRecruit, asCommand),
			"set-foe": decides(SwFoe, asCommand),
			"set-play": decides(SwPlay, asCommand),
			"set-unplay": decides(SwUnplay, asCommand),
			"set-place": decides(SwPlace, asCommand),
			"set-start": decides(SwStartFight, asCommand),
			"set-move": decides(SwMove, asCommand),
			"set-attack": decides(SwAttack, asCommand),
			"set-done": decides(SwEndTurn, asCommand),
			"set-end": decides(SwEndFight, asCommand),
			"pf-pc": decides(PfJoinPc, asCommand),
			"pf-add": decides(PfAddCreatures, asCommand),
			"pf-play": decides(PfPlay, asCommand),
			"pf-unplay": decides(PfUnplay, asCommand),
			"pf-init": decides(PfRollInitiative, asCommand),
			"pf-start": decides(PfStartEncounter, asCommand),
			"pf-turn": decides(PfTakeTurn, asCommand),
			"pf-done": decides(PfEndTurn, asCommand),
			"pf-delay": decides(PfDelay, asCommand),
			"pf-join": decides(PfJoin, asCommand),
			"pf-end": decides(PfEndEncounter, asCommand),
			"pf-strike": decides(PfStrike, asCommand),
			"pf-stride": decides(PfStride, asCommand),
			"pf-step": decides(PfStep, asCommand),
			"pf-crawl": decides(PfCrawl, asCommand),
			"pf-move": decides(PfMove, asCommand),
			"pf-place": decides(PfPlace, asCommand),
			"pf-stand": decides(PfStand, asCommand),
			"pf-drop": decides(PfDrop, asCommand),
			"pf-shield": decides(PfRaiseShield, asCommand),
			"pf-block": decides(PfBlock, asCommand),
			"pf-grapple": decides(PfGrapple, asCommand),
			"pf-trip": decides(PfTrip, asCommand),
			"pf-shove": decides(PfShove, asCommand),
			"pf-disarm": decides(PfDisarm, asCommand),
			"pf-demoralize": decides(PfDemoralize, asCommand),
			"pf-check": decides(PfCheck, asCommand),
			"pf-save": decides(PfSave, asCommand),
			"pf-flat": decides(PfFlat, asCommand),
			"pf-cast": decides(PfCastSpell, asCommand),
			"pf-dmg": decides(PfDamage, asCommand),
			"pf-heal": decides(PfHeal, asCommand),
			"pf-temp": decides(PfSetTemp, asCommand),
			"pf-cond": decides(PfCondition, asCommand),
			"pf-hp": decides(PfHeroPoints, asCommand),
			"pf-reroll": decides(PfReroll, asCommand),
			"pf-recover": decides(PfRecover, asCommand),
			"pf-rest": decides(PfRest, asCommand),
			"pf-map": decides(PfLoadMap, asCommand),
			"pf-dist": decides(PfMeasure, asCommand),
		},
		evolve: {
			"core.chat-posted": fold,
			"core.name-set": fold,
			"core.dice-rolled": fold,
			"core.retracted": fold,
			"core.redone": fold,
			"ds.hero-joined": fold,
			"ds.hero-claimed": fold,
			"ds.hero-released": fold,
			"ds.creatures-added": fold,
			"ds.combat-started": fold,
			"ds.first-set": fold,
			"ds.round-started": fold,
			"ds.turn-started": fold,
			"ds.turn-ended": fold,
			"ds.combat-ended": fold,
			"ds.rested": fold,
			"ds.power-rolled": fold,
			"ds.ability-used": fold,
			"ds.bled": fold,
			"ds.damaged": fold,
			"ds.healed": fold,
			"ds.temp-set": fold,
			"ds.recovered": fold,
			"ds.condition-set": fold,
			"ds.condition-removed": fold,
			"ds.saved": fold,
			"ds.resource-changed": fold,
			"ds.surges-changed": fold,
			"ds.malice-changed": fold,
			"ds.tokens-changed": fold,
			"ds.tokens-reset": fold,
			"ds.victories-changed": fold,
			"ds.map-loaded": fold,
			"ds.map-cleared": fold,
			"ds.placed": fold,
			"ds.moved": fold,
			"ds.force-moved": fold,
			"ds.measured": fold,
			"sw.fighter-joined": fold,
			"sw.fighter-claimed": fold,
			"sw.fighter-released": fold,
			"sw.map-loaded": fold,
			"sw.map-cleared": fold,
			"sw.placed": fold,
			"sw.moved": fold,
			"sw.fight-started": fold,
			"sw.turn-began": fold,
			"sw.attacked": fold,
			"sw.turn-ended": fold,
			"sw.fight-ended": fold,
			"pf.pc-joined": fold,
			"pf.creatures-added": fold,
			"pf.pc-claimed": fold,
			"pf.pc-released": fold,
			"pf.initiative-rolled": fold,
			"pf.combat-started": fold,
			"pf.turn-started": fold,
			"pf.turn-ended": fold,
			"pf.delayed": fold,
			"pf.rejoined": fold,
			"pf.combat-ended": fold,
			"pf.struck": fold,
			"pf.moved": fold,
			"pf.placed": fold,
			"pf.map-loaded": fold,
			"pf.map-cleared": fold,
			"pf.measured": fold,
			"pf.stood": fold,
			"pf.dropped-prone": fold,
			"pf.shield-raised": fold,
			"pf.shield-blocked": fold,
			"pf.maneuvered": fold,
			"pf.checked": fold,
			"pf.saved": fold,
			"pf.flat-checked": fold,
			"pf.cast": fold,
			"pf.damaged": fold,
			"pf.healed": fold,
			"pf.temp-set": fold,
			"pf.condition-set": fold,
			"pf.condition-removed": fold,
			"pf.persistent-set": fold,
			"pf.persistent-removed": fold,
			"pf.hero-points-set": fold,
			"pf.rerolled": fold,
			"pf.heroic-recovery": fold,
			"pf.rested": fold,
		},
	},
	{
		description:
			"One table: its chat, names and dice, and the game the campaign plays, folded from one log.",
	}
) {}
