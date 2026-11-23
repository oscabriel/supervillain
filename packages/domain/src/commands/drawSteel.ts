import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	DsAbilityUsed,
	DsBled,
	DsCombatEnded,
	DsCombatStarted,
	DsConditionRemoved,
	DsConditionSet,
	DsCreaturesAdded,
	DsDamaged,
	DsFirstSet,
	DsForceMoved,
	DsHealed,
	DsHeroClaimed,
	DsHeroJoined,
	DsHeroReleased,
	DsMaliceChanged,
	DsMapCleared,
	DsMapLoaded,
	DsMeasured,
	DsMoved,
	DsPlaced,
	DsPowerRolled,
	DsRecovered,
	DsResourceChanged,
	DsRested,
	DsRoundStarted,
	DsSaved,
	DsSurgesChanged,
	DsTempSet,
	DsTokensChanged,
	DsTokensReset,
	DsTurnEnded,
	DsTurnStarted,
	DsVictoriesChanged,
} from "../events/drawSteel.ts";
import {
	MapGenerationSchema,
	MapGridSchema,
	SquareSchema,
} from "../external/content.ts";
import { Refused } from "../Refused.rejection.ts";
import { HeroSheetSchema, StatBlockSchema } from "../rules/drawSteel/schema.ts";
import { CONDITIONS } from "../rules/drawSteel/state.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

const ConditionSchema = Schema.Literals(CONDITIONS);

const ForcedFields = {
	who: Schema.String,
	distance: Schema.Int,
	from: Schema.optionalKey(Schema.String),
	to: Schema.optionalKey(SquareSchema),
};

export class DsJoinHero extends Domain.Command(
	"hero",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { hero: Schema.String, sheet: Schema.optionalKey(HeroSheetSchema) },
		events: [DsHeroJoined],
		rejects: [Refused],
	},
	{
		description:
			"Bring a hero into the party from its sheet, or reload the sheet.",
	}
) {}

export class DsAddCreatures extends Domain.Command(
	"add",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			monster: Schema.String,
			count: Schema.Int,
			as: Schema.optionalKey(Schema.String),
			sheet: Schema.optionalKey(StatBlockSchema),
		},
		events: [DsCreaturesAdded],
		rejects: [Refused],
	},
	{
		description:
			"Add creatures from a stat block; minions form squads of up to eight.",
	}
) {}

export class DsPlay extends Domain.Command(
	"play",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			hero: Schema.optionalKey(Schema.String),
			player: Schema.optionalKey(Schema.String),
			playerActor: Schema.optionalKey(Schema.String),
			seated: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [DsHeroClaimed],
		rejects: [Refused],
	},
	{ description: "Play a hero, or as the GM give one to a player." }
) {}

export class DsUnplay extends Domain.Command(
	"unplay",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { hero: Schema.optionalKey(Schema.String) },
		events: [DsHeroReleased],
		rejects: [Refused],
	},
	{ description: "Stop playing a hero." }
) {}

export class DsStartCombat extends Domain.Command(
	"start",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [DsCombatStarted],
		rejects: [Refused],
	},
	{ description: "Start combat: who picks first, resources and Malice." }
) {}

export class DsSetFirst extends Domain.Command(
	"first",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { side: Schema.Literals(["heroes", "director"]) },
		events: [DsFirstSet],
		rejects: [Refused],
	},
	{ description: "Say which side goes first, every round." }
) {}

export class DsTakeTurn extends Domain.Command(
	"turn",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.optionalKey(Schema.String) },
		events: [DsRoundStarted, DsTurnEnded, DsTurnStarted],
		rejects: [Refused],
	},
	{ description: "Start a turn." }
) {}

export class DsEndTurn extends Domain.Command(
	"done",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [DsTurnEnded],
		rejects: [Refused],
	},
	{ description: "End the current turn." }
) {}

export class DsNextRound extends Domain.Command(
	"round",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [DsRoundStarted, DsTurnEnded],
		rejects: [Refused],
	},
	{ description: "Start the next round now." }
) {}

export class DsEndCombat extends Domain.Command(
	"end",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [DsCombatEnded],
		rejects: [Refused],
	},
	{ description: "End the combat." }
) {}

export class DsRest extends Domain.Command(
	"rest",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [DsRested],
		rejects: [Refused],
	},
	{ description: "Take a respite." }
) {}

export class DsPowerRoll extends Domain.Command(
	"pr",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			ability: Schema.optionalKey(Schema.String),
			bonus: Schema.optionalKey(Schema.Int),
			edges: Schema.Int,
			banes: Schema.Int,
			targets: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [DsAbilityUsed, DsBled, DsDamaged, DsPowerRolled],
		rejects: [Refused],
	},
	{ description: "Make a power roll, with an ability or a characteristic." }
) {}

export class DsDamage extends Domain.Command(
	"dmg",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			amount: Schema.Int,
			damageType: Schema.optionalKey(Schema.String),
		},
		events: [DsDamaged],
		rejects: [Refused],
	},
	{ description: "Deal damage, after weakness and immunity." }
) {}

export class DsFreeStrike extends Domain.Command(
	"fs",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			target: Schema.String,
			damageType: Schema.optionalKey(Schema.String),
			minions: Schema.optionalKey(Schema.Int),
		},
		events: [DsDamaged],
		rejects: [Refused],
	},
	{ description: "A creature or squad makes its free strike." }
) {}

export class DsHeal extends Domain.Command(
	"heal",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, amount: Schema.Int },
		events: [DsHealed],
		rejects: [Refused],
	},
	{ description: "Regain Stamina, up to max." }
) {}

export class DsSetTemp extends Domain.Command(
	"temp",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, amount: Schema.Int },
		events: [DsTempSet],
		rejects: [Refused],
	},
	{ description: "Set temporary Stamina." }
) {}

export class DsRecover extends Domain.Command(
	"recover",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, ally: Schema.Boolean },
		events: [DsRecovered],
		rejects: [Refused],
	},
	{ description: "Spend a Recovery." }
) {}

export class DsCondition extends Domain.Command(
	"cond",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			condition: ConditionSchema,
			duration: Schema.optionalKey(Schema.Literals(["eot", "save", "end"])),
			remove: Schema.optionalKey(Schema.Boolean),
			by: Schema.optionalKey(Schema.String),
		},
		events: [DsConditionRemoved, DsConditionSet],
		rejects: [Refused],
	},
	{ description: "Give or remove a condition." }
) {}

export class DsSave extends Domain.Command(
	"save",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			condition: Schema.optionalKey(ConditionSchema),
		},
		events: [DsSaved],
		rejects: [Refused],
	},
	{ description: "Roll a saving throw against a condition." }
) {}

export class DsResource extends Domain.Command(
	"res",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, by: Schema.Int },
		events: [DsResourceChanged],
		rejects: [Refused],
	},
	{ description: "Gain or spend heroic resource." }
) {}

export class DsSurge extends Domain.Command(
	"surge",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, by: Schema.Int },
		events: [DsSurgesChanged],
		rejects: [Refused],
	},
	{ description: "Gain or spend surges." }
) {}

export class DsMalice extends Domain.Command(
	"malice",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { by: Schema.Int, reason: Schema.optionalKey(Schema.String) },
		events: [DsMaliceChanged],
		rejects: [Refused],
	},
	{ description: "Change the Director's Malice." }
) {}

export class DsToken extends Domain.Command(
	"token",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { change: Schema.Union([Schema.Int, Schema.Literal("reset")]) },
		events: [DsTokensChanged, DsTokensReset],
		rejects: [Refused],
	},
	{ description: "Spend, gain or reset hero tokens." }
) {}

export class DsVictory extends Domain.Command(
	"victory",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.optionalKey(Schema.String), by: Schema.Int },
		events: [DsVictoriesChanged],
		rejects: [Refused],
	},
	{ description: "Change Victories." }
) {}

export class DsLoadMap extends Domain.Command(
	"map",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.optionalKey(Schema.String),
			grid: Schema.optionalKey(MapGridSchema),
			generate: Schema.optionalKey(MapGenerationSchema),
		},
		events: [DsMapCleared, DsMapLoaded],
		rejects: [Refused],
	},
	{ description: "Load the encounter map, or put it away." }
) {}

export class DsPlace extends Domain.Command(
	"place",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, at: SquareSchema },
		events: [DsPlaced],
		rejects: [Refused],
	},
	{ description: "Put a token on the map." }
) {}

export class DsMove extends Domain.Command(
	"move",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			to: SquareSchema,
			main: Schema.optionalKey(Schema.Boolean),
		},
		events: [DsBled, DsMoved],
		rejects: [Refused],
	},
	{ description: "Move a token along its cheapest path." }
) {}

export class DsMeasure extends Domain.Command(
	"dist",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { from: Schema.String, to: Schema.String },
		events: [DsMeasured],
		rejects: [Refused],
	},
	{ description: "Count the squares between tokens or squares." }
) {}

export class DsPush extends Domain.Command(
	"push",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ForcedFields,
		events: [DsDamaged, DsForceMoved],
		rejects: [Refused],
	},
	{ description: "Push straight away from the source, less stability." }
) {}

export class DsPull extends Domain.Command(
	"pull",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ForcedFields,
		events: [DsDamaged, DsForceMoved],
		rejects: [Refused],
	},
	{ description: "Pull straight toward the source, less stability." }
) {}

export class DsSlide extends Domain.Command(
	"slide",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ForcedFields,
		events: [DsDamaged, DsForceMoved],
		rejects: [Refused],
	},
	{ description: "Slide any way to a square, less stability." }
) {}

export const DS_COMMANDS = [
	DsJoinHero,
	DsAddCreatures,
	DsPlay,
	DsUnplay,
	DsStartCombat,
	DsSetFirst,
	DsTakeTurn,
	DsEndTurn,
	DsNextRound,
	DsEndCombat,
	DsRest,
	DsPowerRoll,
	DsDamage,
	DsFreeStrike,
	DsHeal,
	DsSetTemp,
	DsRecover,
	DsCondition,
	DsSave,
	DsResource,
	DsSurge,
	DsMalice,
	DsToken,
	DsVictory,
	DsLoadMap,
	DsPlace,
	DsMove,
	DsMeasure,
	DsPush,
	DsPull,
	DsSlide,
] as const;

export type DsTableCommand =
	| DsJoinHero
	| DsAddCreatures
	| DsPlay
	| DsUnplay
	| DsStartCombat
	| DsSetFirst
	| DsTakeTurn
	| DsEndTurn
	| DsNextRound
	| DsEndCombat
	| DsRest
	| DsPowerRoll
	| DsDamage
	| DsFreeStrike
	| DsHeal
	| DsSetTemp
	| DsRecover
	| DsCondition
	| DsSave
	| DsResource
	| DsSurge
	| DsMalice
	| DsToken
	| DsVictory
	| DsLoadMap
	| DsPlace
	| DsMove
	| DsMeasure
	| DsPush
	| DsPull
	| DsSlide;
