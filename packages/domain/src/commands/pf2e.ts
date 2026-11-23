import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
	PfCast,
	PfChecked,
	PfCombatEnded,
	PfCombatStarted,
	PfConditionRemoved,
	PfConditionSet,
	PfCreaturesAdded,
	PfDamaged,
	PfDelayed,
	PfDroppedProne,
	PfFlatChecked,
	PfHealed,
	PfHeroPointsSet,
	PfHeroicRecovery,
	PfInitiativeRolled,
	PfManeuvered,
	PfMapCleared,
	PfMapLoaded,
	PfMeasured,
	PfMoved,
	PfPcClaimed,
	PfPcJoined,
	PfPcReleased,
	PfPersistentRemoved,
	PfPersistentSet,
	PfPlaced,
	PfRejoined,
	PfRerolled,
	PfRested,
	PfSaved,
	PfShieldBlocked,
	PfShieldRaised,
	PfStood,
	PfStruck,
	PfTempSet,
	PfTurnEnded,
	PfTurnStarted,
} from "../events/pf2e.ts";
import {
	MapGenerationSchema,
	MapGridSchema,
	SquareSchema,
} from "../external/content.ts";
import { Refused } from "../Refused.rejection.ts";
import {
	PfCreatureBlockSchema,
	PfHeroSheetSchema,
} from "../rules/pf2e/schema.ts";
import { SAVES } from "../rules/pf2e/sheets.ts";
import { EXPIRIES } from "../rules/pf2e/state.ts";
import { Roller, Session } from "../Session.middleware.ts";
import { TableId } from "../Table.id.ts";

const WhoFields = { who: Schema.String };

const MoveFields = { who: Schema.String, to: SquareSchema };

const ManeuverFields = {
	who: Schema.String,
	target: Schema.String,
	modifier: Schema.optionalKey(Schema.Int),
};

export class PfJoinPc extends Domain.Command(
	"pf-pc",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { id: Schema.String, sheet: Schema.optionalKey(PfHeroSheetSchema) },
		events: [PfPcJoined],
		rejects: [Refused],
	},
	{
		description:
			"Bring a PC into the party from its sheet, or load the sheet again.",
	}
) {}

export class PfAddCreatures extends Domain.Command(
	"pf-add",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			monster: Schema.String,
			count: Schema.Int,
			adjustment: Schema.optionalKey(Schema.Literals(["elite", "weak"])),
			as: Schema.optionalKey(Schema.String),
			sheet: Schema.optionalKey(PfCreatureBlockSchema),
		},
		events: [PfCreaturesAdded],
		rejects: [Refused],
	},
	{ description: "Add creatures from a stat block, elite or weak if asked." }
) {}

export class PfPlay extends Domain.Command(
	"pf-play",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			seated: Schema.optionalKey(Schema.Array(Schema.String)),
		},
		events: [PfPcClaimed],
		rejects: [Refused],
	},
	{ description: "Play a PC." }
) {}

export class PfUnplay extends Domain.Command(
	"pf-unplay",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.optionalKey(Schema.String) },
		events: [PfPcReleased],
		rejects: [Refused],
	},
	{ description: "Stop playing a PC." }
) {}

export class PfRollInitiative extends Domain.Command(
	"pf-init",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.optionalKey(Schema.String),
			skill: Schema.optionalKey(Schema.String),
		},
		events: [PfInitiativeRolled],
		rejects: [Refused],
	},
	{ description: "Roll initiative with Perception or a skill." }
) {}

export class PfStartEncounter extends Domain.Command(
	"pf-start",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [PfInitiativeRolled, PfCombatStarted, PfTurnStarted],
		rejects: [Refused],
	},
	{
		description:
			"Start the encounter: initiative for whoever lacks it, then the first turn.",
	}
) {}

export class PfTakeTurn extends Domain.Command(
	"pf-turn",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String },
		events: [PfTurnEnded, PfTurnStarted],
		rejects: [Refused],
	},
	{ description: "Start a creature's turn out of order." }
) {}

export class PfEndTurn extends Domain.Command(
	"pf-done",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [PfTurnEnded, PfTurnStarted],
		rejects: [Refused],
	},
	{ description: "End the turn, and start the next in initiative." }
) {}

export class PfDelay extends Domain.Command(
	"pf-delay",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [PfTurnEnded, PfDelayed, PfTurnStarted],
		rejects: [Refused],
	},
	{ description: "Delay: leave the initiative order." }
) {}

export class PfJoin extends Domain.Command(
	"pf-join",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String },
		events: [PfRejoined],
		rejects: [Refused],
	},
	{ description: "Return a delaying creature to the initiative order." }
) {}

export class PfEndEncounter extends Domain.Command(
	"pf-end",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [PfCombatEnded],
		rejects: [Refused],
	},
	{ description: "End the encounter." }
) {}

export class PfStrike extends Domain.Command(
	"pf-strike",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			weapon: Schema.String,
			target: Schema.String,
			modifier: Schema.optionalKey(Schema.Int),
			cover: Schema.optionalKey(
				Schema.Literals(["lesser", "standard", "greater"])
			),
			reaction: Schema.optionalKey(Schema.Boolean),
		},
		events: [PfStruck],
		rejects: [Refused],
	},
	{ description: "Strike a target with a weapon or unarmed attack." }
) {}

export class PfStride extends Domain.Command(
	"pf-stride",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: MoveFields,
		events: [PfMoved],
		rejects: [Refused],
	},
	{ description: "Stride up to the creature's Speed." }
) {}

export class PfStep extends Domain.Command(
	"pf-step",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: MoveFields,
		events: [PfMoved],
		rejects: [Refused],
	},
	{ description: "Step 5 feet." }
) {}

export class PfCrawl extends Domain.Command(
	"pf-crawl",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: MoveFields,
		events: [PfMoved],
		rejects: [Refused],
	},
	{ description: "Crawl 5 feet while prone." }
) {}

export class PfMove extends Domain.Command(
	"pf-move",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: MoveFields,
		events: [PfMoved],
		rejects: [Refused],
	},
	{ description: "Move a creature without an action." }
) {}

export class PfPlace extends Domain.Command(
	"pf-place",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: MoveFields,
		events: [PfPlaced],
		rejects: [Refused],
	},
	{ description: "Put a creature on the map." }
) {}

export class PfStand extends Domain.Command(
	"pf-stand",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: WhoFields,
		events: [PfStood],
		rejects: [Refused],
	},
	{ description: "Stand up from prone." }
) {}

export class PfDrop extends Domain.Command(
	"pf-drop",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: WhoFields,
		events: [PfDroppedProne],
		rejects: [Refused],
	},
	{ description: "Drop prone." }
) {}

export class PfRaiseShield extends Domain.Command(
	"pf-shield",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: WhoFields,
		events: [PfShieldRaised],
		rejects: [Refused],
	},
	{ description: "Raise a shield." }
) {}

export class PfBlock extends Domain.Command(
	"pf-block",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, damage: Schema.optionalKey(Schema.Int) },
		events: [PfShieldBlocked],
		rejects: [Refused],
	},
	{ description: "Shield Block damage just taken." }
) {}

export class PfGrapple extends Domain.Command(
	"pf-grapple",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ManeuverFields,
		events: [PfManeuvered],
		rejects: [Refused],
	},
	{ description: "Grapple a target." }
) {}

export class PfTrip extends Domain.Command(
	"pf-trip",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ManeuverFields,
		events: [PfManeuvered],
		rejects: [Refused],
	},
	{ description: "Trip a target." }
) {}

export class PfShove extends Domain.Command(
	"pf-shove",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ManeuverFields,
		events: [PfManeuvered],
		rejects: [Refused],
	},
	{ description: "Shove a target." }
) {}

export class PfDisarm extends Domain.Command(
	"pf-disarm",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ManeuverFields,
		events: [PfManeuvered],
		rejects: [Refused],
	},
	{ description: "Disarm a target." }
) {}

export class PfDemoralize extends Domain.Command(
	"pf-demoralize",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: ManeuverFields,
		events: [PfManeuvered],
		rejects: [Refused],
	},
	{ description: "Demoralize a target." }
) {}

export class PfCheck extends Domain.Command(
	"pf-check",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			skill: Schema.String,
			dc: Schema.optionalKey(Schema.Int),
			modifier: Schema.optionalKey(Schema.Int),
		},
		events: [PfChecked],
		rejects: [Refused],
	},
	{ description: "Roll a skill or Perception check." }
) {}

export class PfSave extends Domain.Command(
	"pf-save",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			save: Schema.Literals(SAVES),
			dc: Schema.Int,
			basic: Schema.optionalKey(Schema.String),
			damageType: Schema.optionalKey(Schema.String),
		},
		events: [PfSaved],
		rejects: [Refused],
	},
	{ description: "Roll a saving throw, basic or not." }
) {}

export class PfFlat extends Domain.Command(
	"pf-flat",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, dc: Schema.Int },
		events: [PfFlatChecked],
		rejects: [Refused],
	},
	{ description: "Roll a flat check." }
) {}

export class PfCastSpell extends Domain.Command(
	"pf-cast",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			spell: Schema.String,
			rank: Schema.optionalKey(Schema.Int),
			targets: Schema.Array(Schema.String),
		},
		events: [PfCast],
		rejects: [Refused],
	},
	{ description: "Cast a spell from the sheet." }
) {}

export class PfDamage extends Domain.Command(
	"pf-dmg",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			amount: Schema.String,
			damageType: Schema.optionalKey(Schema.String),
			critical: Schema.optionalKey(Schema.Boolean),
		},
		events: [PfDamaged],
		rejects: [Refused],
	},
	{ description: "Deal damage to a creature." }
) {}

export class PfHeal extends Domain.Command(
	"pf-heal",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, amount: Schema.String },
		events: [PfHealed],
		rejects: [Refused],
	},
	{ description: "Restore a creature's HP." }
) {}

export class PfSetTemp extends Domain.Command(
	"pf-temp",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, amount: Schema.Int },
		events: [PfTempSet],
		rejects: [Refused],
	},
	{ description: "Give temporary HP." }
) {}

export class PfCondition extends Domain.Command(
	"pf-cond",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			name: Schema.String,
			value: Schema.optionalKey(Schema.Int),
			expires: Schema.optionalKey(Schema.Literals(EXPIRIES)),
			by: Schema.optionalKey(Schema.String),
			remove: Schema.optionalKey(Schema.Boolean),
			damageType: Schema.optionalKey(Schema.String),
			dice: Schema.optionalKey(Schema.String),
		},
		events: [
			PfConditionRemoved,
			PfConditionSet,
			PfPersistentRemoved,
			PfPersistentSet,
		],
		rejects: [Refused],
	},
	{ description: "Set or lift a condition or persistent damage." }
) {}

export class PfHeroPoints extends Domain.Command(
	"pf-hp",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			who: Schema.String,
			by: Schema.optionalKey(Schema.Int),
			reset: Schema.optionalKey(Schema.Boolean),
		},
		events: [PfHeroPointsSet],
		rejects: [Refused],
	},
	{ description: "Give, spend or reset Hero Points." }
) {}

export class PfReroll extends Domain.Command(
	"pf-reroll",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: WhoFields,
		events: [PfRerolled],
		rejects: [Refused],
	},
	{ description: "Spend a Hero Point to reroll the latest check." }
) {}

export class PfRecover extends Domain.Command(
	"pf-recover",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: WhoFields,
		events: [PfHeroicRecovery],
		rejects: [Refused],
	},
	{ description: "Heroic Recovery: spend every Hero Point to stop dying." }
) {}

export class PfRest extends Domain.Command(
	"pf-rest",
	{
		target: TableId,
		middleware: [Session, Roller],
		events: [PfRested],
		rejects: [Refused],
	},
	{ description: "Rest for the night." }
) {}

export class PfLoadMap extends Domain.Command(
	"pf-map",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: {
			id: Schema.optionalKey(Schema.String),
			grid: Schema.optionalKey(MapGridSchema),
			generate: Schema.optionalKey(MapGenerationSchema),
		},
		events: [PfMapCleared, PfMapLoaded],
		rejects: [Refused],
	},
	{ description: "Load the encounter's map, or put it away." }
) {}

export class PfMeasure extends Domain.Command(
	"pf-dist",
	{
		target: TableId,
		middleware: [Session, Roller],
		input: { who: Schema.String, target: Schema.String },
		events: [PfMeasured],
		rejects: [Refused],
	},
	{ description: "Measure the distance between two creatures." }
) {}

export const PF_COMMANDS = [
	PfJoinPc,
	PfAddCreatures,
	PfPlay,
	PfUnplay,
	PfRollInitiative,
	PfStartEncounter,
	PfTakeTurn,
	PfEndTurn,
	PfDelay,
	PfJoin,
	PfEndEncounter,
	PfStrike,
	PfStride,
	PfStep,
	PfCrawl,
	PfMove,
	PfPlace,
	PfStand,
	PfDrop,
	PfRaiseShield,
	PfBlock,
	PfGrapple,
	PfTrip,
	PfShove,
	PfDisarm,
	PfDemoralize,
	PfCheck,
	PfSave,
	PfFlat,
	PfCastSpell,
	PfDamage,
	PfHeal,
	PfSetTemp,
	PfCondition,
	PfHeroPoints,
	PfReroll,
	PfRecover,
	PfRest,
	PfLoadMap,
	PfMeasure,
] as const;

export type PfTableCommand =
	| PfJoinPc
	| PfAddCreatures
	| PfPlay
	| PfUnplay
	| PfRollInitiative
	| PfStartEncounter
	| PfTakeTurn
	| PfEndTurn
	| PfDelay
	| PfJoin
	| PfEndEncounter
	| PfStrike
	| PfStride
	| PfStep
	| PfCrawl
	| PfMove
	| PfPlace
	| PfStand
	| PfDrop
	| PfRaiseShield
	| PfBlock
	| PfGrapple
	| PfTrip
	| PfShove
	| PfDisarm
	| PfDemoralize
	| PfCheck
	| PfSave
	| PfFlat
	| PfCastSpell
	| PfDamage
	| PfHeal
	| PfSetTemp
	| PfCondition
	| PfHeroPoints
	| PfReroll
	| PfRecover
	| PfRest
	| PfLoadMap
	| PfMeasure;
