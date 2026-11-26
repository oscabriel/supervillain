import {
	ID,
	RULESET_NAMES,
	STAT_KEY,
	TAG,
	TRACKER_KINDS,
} from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";
import { Schema } from "effect";

import { PfSheetFileSchema } from "./pfSheetFiles.ts";
import { HeroFileSchema, MonsterFileSchema } from "./sheetFiles.ts";

const text = (max: number, description: string, example: string) =>
	Schema.String.check(
		Schema.isNonEmpty({ message: "must not be empty" }),
		Schema.isMaxLength(max, { message: `must be at most ${max} characters` })
	).annotate({ description, examples: [example] });

const IdSchema = Schema.String.check(
	Schema.isPattern(ID, {
		message:
			"must be an id: lower-case letters, digits and hyphens, at most 40, like a file's name without .md",
	})
).annotate({
	description:
		"An id: a file's name without its extension, in lower-case letters, digits and hyphens.",
	examples: ["harbour-master"],
});

const ids = (description: string, example: string) =>
	Schema.Array(IdSchema).annotate({ description, examples: [[example]] });

const TagSchema = Schema.String.check(
	Schema.isPattern(TAG, {
		message:
			"must be a tag: lower-case letters, digits and hyphens, at most 24",
	})
).annotate({ description: "A short tag.", examples: ["smuggler"] });

const Tags = Schema.Array(TagSchema).annotate({
	description: "Short tags, like [smuggler, ally].",
	examples: [["smuggler", "ally"]],
});

const Stats = Schema.Record(
	Schema.String.check(
		Schema.isPattern(STAT_KEY, {
			message:
				"must be a stat's key: a lower-case letter, then up to 15 lower-case letters, digits or hyphens",
		})
	),
	Schema.Int.check(
		Schema.isBetween(
			{ minimum: -9999, maximum: 9999 },
			{ message: "must be a whole number within 9999" }
		)
	)
).annotate({
	description: "Named whole numbers, like { might: 2, wits: 1 }.",
	examples: [{ might: 2, wits: 1 }],
});

const Resources = Schema.Record(
	Stats.key,
	Schema.Int.check(
		Schema.isBetween(
			{ minimum: 0, maximum: 9999 },
			{ message: "must be a whole number from 0 to 9999" }
		)
	)
);

export const TableFrontSchema = Schema.Struct({
	rules: Schema.optionalKey(
		Schema.Literals(RULESET_NAMES).annotate({
			description:
				"What the campaign plays. It may live here or in campaign.yaml, not both.",
			examples: ["freeform"],
		})
	),
	title: text(80, "The campaign's name.", "The Drowned Crown"),
	pitch: Schema.optionalKey(
		text(
			500,
			"A sentence or two to sell the campaign.",
			"Smugglers and saints."
		)
	),
	start: Schema.optionalKey(
		IdSchema.annotate({ description: "The scene the campaign opens on." })
	),
	sync: Schema.optionalKey(
		Schema.Literals(["auto", "manual"]).annotate({
			description:
				"auto: the table reads edited files again by itself; manual: only on /sync. Default auto.",
			examples: ["auto"],
		})
	),
}).annotate({
	identifier: "TableFront",
	title: "table.md",
	description: "The campaign's front page: its title, pitch and opening scene.",
});

export const EncounterSchema = Schema.Struct({
	map: Schema.optionalKey(
		IdSchema.annotate({ description: "The map in maps/ the fight is on." })
	),
	monsters: Schema.Array(
		Schema.Struct({
			id: IdSchema.annotate({ description: "A sheet in monsters/." }),
			count: Schema.optionalKey(
				Schema.Int.check(
					Schema.isBetween(
						{ minimum: 1, maximum: 12 },
						{ message: "must be a whole number from 1 to 12" }
					)
				).annotate({ description: "How many, 1 to 12. Default 1." })
			),
		})
	).annotate({
		description: "Who the party fights, by their sheets in monsters/.",
		examples: [[{ id: "dock-thug", count: 3 }]],
	}),
}).annotate({
	description: "The scene's fight, ready to start from the prep panel.",
});

export const TrackerFrontSchema = Schema.Struct({
	id: Schema.String.check(
		Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,23}$/u, {
			message:
				"must be a tracker's id: lower-case letters, digits and hyphens, at most 24",
		})
	).annotate({
		description: "The tracker's id, for /tick.",
		examples: ["alarm"],
	}),
	label: text(40, "What the table sees it called.", "The alarm"),
	kind: Schema.Literals(TRACKER_KINDS).annotate({
		description: "clock (fills up), counter (counts) or quest (steps).",
	}),
	value: Schema.optionalKey(
		Schema.Int.check(
			Schema.isBetween(
				{ minimum: 0, maximum: 999 },
				{ message: "must be 0 to 999" }
			)
		)
	),
	max: Schema.optionalKey(
		Schema.Int.check(
			Schema.isBetween(
				{ minimum: 1, maximum: 999 },
				{ message: "must be 1 to 999" }
			)
		)
	),
});

export const SceneFrontSchema = Schema.Struct({
	title: text(80, "The scene's name.", "The Drowned Market"),
	summary: Schema.optionalKey(
		text(80, "A line for the codex.", "Stalls on stilts over black water.")
	),
	npcs: Schema.optionalKey(
		ids("Who is here, by their files in npcs/.", "mara")
	),
	handouts: Schema.optionalKey(
		ids("What the party can be handed, from handouts/.", "ledger-page")
	),
	items: Schema.optionalKey(
		ids("What can be found, from items/.", "brass-key")
	),
	map: Schema.optionalKey(
		IdSchema.annotate({ description: "The scene's map, in maps/." })
	),
	encounter: Schema.optionalKey(EncounterSchema),
	trackers: Schema.optionalKey(
		Schema.Array(TrackerFrontSchema).annotate({
			description: "Clocks, counters and quests the scene sets up.",
		})
	),
	next: Schema.optionalKey(
		Schema.Union([IdSchema, Schema.Array(IdSchema)]).annotate({
			description: "The scene or scenes that can follow this one.",
			examples: ["the-old-lighthouse"],
		})
	),
}).annotate({
	identifier: "SceneFront",
	title: "scenes/*.md",
	description:
		"A scene: its title, who and what is in it, its fight, and what can follow. Its body is the scene's text; ## Read Aloud is read to the table and ## GM Notes stay with the GM.",
});

export const NpcFrontSchema = Schema.Struct({
	name: text(80, "What the table calls them.", "Mara Venn"),
	role: Schema.optionalKey(
		text(80, "A line on who they are.", "Harbour-master")
	),
	pronouns: Schema.optionalKey(text(40, "Their pronouns.", "she/her")),
	monster: Schema.optionalKey(
		IdSchema.annotate({
			description: "Their sheet in monsters/, if they fight.",
		})
	),
	tags: Schema.optionalKey(Tags),
	portrait: Schema.optionalKey(
		IdSchema.annotate({
			description: "Their picture: art/<id>.txt, at most 40 lines of 80.",
		})
	),
}).annotate({
	identifier: "NpcFront",
	title: "npcs/*.md",
	description: "Someone the party can meet.",
});

export const HandoutFrontSchema = Schema.Struct({
	title: text(80, "The handout's name.", "A torn ledger page"),
	kind: Schema.optionalKey(
		Schema.Literals(["prose", "clue", "art", "map"]).annotate({
			description: "prose, clue, art or map. Default prose.",
		})
	),
	map: Schema.optionalKey(
		IdSchema.annotate({ description: "A map in maps/ the handout shows." })
	),
	art: Schema.optionalKey(
		IdSchema.annotate({
			description: "A picture: art/<id>.txt, at most 40 lines of 80.",
		})
	),
}).annotate({
	identifier: "HandoutFront",
	title: "handouts/*.md",
	description:
		"Something handed to the players: a letter, a clue, a picture or a map.",
});

const entryFields = {
	name: text(80, "Its name.", "Brass key"),
	tags: Schema.optionalKey(Tags),
	summary: Schema.optionalKey(
		text(80, "A line for the codex.", "Opens the customs house.")
	),
	level: Schema.optionalKey(
		Schema.Int.annotate({ description: "Its level, if the rules have one." })
	),
	traits: Schema.optionalKey(
		Schema.Array(text(40, "A trait.", "magical")).annotate({
			description: "The rules' traits, if they have them.",
		})
	),
	stats: Schema.optionalKey(Stats),
};

export const ItemFrontSchema = Schema.Struct({
	...entryFields,
	cost: Schema.optionalKey(text(40, "What it costs.", "5 gp")),
}).annotate({
	identifier: "ItemFront",
	title: "items/*.md",
	description: "Something the party can find, carry or buy.",
});

export const AncestryFrontSchema = Schema.Struct({
	...entryFields,
	speed: Schema.optionalKey(
		Schema.Int.annotate({ description: "Speed, if the rules have one." })
	),
	size: Schema.optionalKey(text(20, "Size, if the rules have one.", "medium")),
}).annotate({
	identifier: "AncestryFront",
	title: "ancestries/*.md",
	description: "A people a character can come from.",
});

export const ClassFrontSchema = Schema.Struct({
	...entryFields,
	hp: Schema.optionalKey(
		Schema.Int.annotate({
			description: "Hit points or stamina, if the rules have them.",
		})
	),
	resource: Schema.optionalKey(
		text(40, "The class's resource, if any.", "Wrath")
	),
}).annotate({
	identifier: "ClassFront",
	title: "classes/*.md",
	description: "A calling a character can follow.",
});

const abilityText = (description: string) =>
	Schema.optionalKey(text(500, description, "3 damage"));

export const AbilityFrontSchema = Schema.Struct({
	name: text(80, "The ability's name.", "Spinning Strike"),
	tags: Schema.optionalKey(Tags),
	summary: Schema.optionalKey(
		text(80, "A line for the codex.", "A whirling blow.")
	),
	kind: Schema.optionalKey(
		text(
			40,
			"Draw Steel: what it costs to use, like Main action.",
			"Main action"
		)
	),
	characteristics: Schema.optionalKey(
		Schema.Array(text(20, "A characteristic.", "might")).annotate({
			description: "Draw Steel: the characteristics its power roll can use.",
		})
	),
	bonus: Schema.optionalKey(Schema.Int),
	cost: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	keywords: Schema.optionalKey(Schema.Array(text(40, "A keyword.", "Melee"))),
	distance: abilityText("Draw Steel: how far it reaches."),
	target: abilityText("Draw Steel: whom it targets."),
	tier1: abilityText("Draw Steel: a result of 11 or less."),
	tier2: abilityText("Draw Steel: a result of 12 to 16."),
	tier3: abilityText("Draw Steel: a result of 17 or more."),
	effect: abilityText("What it does besides."),
	actions: Schema.optionalKey(
		Schema.Union([text(20, "Actions.", "reaction"), Schema.Int]).annotate({
			description: "PF2e: how many actions, or free or reaction.",
		})
	),
	traits: Schema.optionalKey(Schema.Array(text(40, "A trait.", "attack"))),
	text: abilityText("PF2e: what it does."),
}).annotate({
	identifier: "AbilityFront",
	title: "abilities/*.md",
	description:
		"An ability a party sheet can list by id; its fields follow the rules the campaign plays.",
});

const refFields = {
	ancestry: Schema.optionalKey(
		IdSchema.annotate({ description: "Their ancestry, in ancestries/." })
	),
	class: Schema.optionalKey(
		IdSchema.annotate({ description: "Their class, in classes/." })
	),
	items: Schema.optionalKey(ids("What they carry, from items/.", "brass-key")),
	abilities: Schema.optionalKey(
		ids("Their abilities, from abilities/.", "spinning-strike")
	),
};

const freeformFields = {
	name: text(40, "What the table calls them.", "Rook"),
	pronouns: Schema.optionalKey(text(40, "Their pronouns.", "she/her")),
	concept: Schema.optionalKey(
		text(80, "Who they are, in a line.", "Disgraced duelist")
	),
	dice: Schema.optionalKey(
		Schema.String.check(
			Schema.isPattern(/^\d{0,3}d\d{1,4}(?:[+-]\d{1,4})?$/u, {
				message: "must be dice like d20 or 2d6",
			})
		).annotate({
			description: "What their checks roll. Default d20.",
			examples: ["2d6"],
		})
	),
	stats: Schema.optionalKey(Stats),
	resources: Schema.optionalKey(
		Resources.annotate({
			description:
				"Resources by their maximum, like { hp: 10 }: they start full and count down.",
			examples: [{ hp: 10 }],
		})
	),
	tags: Schema.optionalKey(Tags),
	portrait: Schema.optionalKey(
		IdSchema.annotate({
			description: "Their picture: art/<id>.txt, at most 40 lines of 80.",
		})
	),
};

export const FreeformPartySchema = Schema.Struct({
	...freeformFields,
	...refFields,
}).annotate({
	identifier: "FreeformPartyFront",
	title: "party/*.md (freeform)",
	description: "A character in the party, with named stats and resources.",
});

export const FreeformMonsterSchema = Schema.Struct(freeformFields).annotate({
	identifier: "FreeformMonsterFront",
	title: "monsters/*.md (freeform)",
	description: "A figure the party can face, with named stats and resources.",
});

const sheetRefs = {
	ancestry: refFields.ancestry,
	items: refFields.items,
};

const DsAbilityRef = Schema.Union([
	IdSchema,
	HeroFileSchema.fields.abilities.schema.value,
]).annotate({
	description: "An ability: its id in abilities/, or the ability itself.",
});

export const DrawSteelPartySchema = Schema.Struct({
	...HeroFileSchema.fields,
	...sheetRefs,
	abilities: Schema.optionalKey(Schema.Array(DsAbilityRef)),
}).annotate({
	identifier: "DrawSteelPartyFront",
	title: "party/*.md (draw-steel)",
	description:
		"A Draw Steel hero: the fields of heroes/<id>.yaml, plus an ancestry and items by id.",
});

export const DrawSteelMonsterSchema = MonsterFileSchema.annotate({
	identifier: "DrawSteelMonsterFront",
	title: "monsters/*.md (draw-steel)",
	description: "A Draw Steel stat block: the fields of monsters/<id>.yaml.",
});

const PfAbilityRef = Schema.Union([
	IdSchema,
	PfSheetFileSchema.fields.abilities.schema.value,
]).annotate({
	description: "An ability: its id in abilities/, or the ability itself.",
});

export const Pf2ePartySchema = Schema.Struct({
	...PfSheetFileSchema.fields,
	items: refFields.items,
	abilities: Schema.optionalKey(Schema.Array(PfAbilityRef)),
}).annotate({
	identifier: "Pf2ePartyFront",
	title: "party/*.md (pf2e)",
	description:
		"A PF2e character: the fields of heroes/<id>.yaml, plus items by id.",
});

export const Pf2eMonsterSchema = PfSheetFileSchema.annotate({
	identifier: "Pf2eMonsterFront",
	title: "monsters/*.md (pf2e)",
	description: "A PF2e creature: the fields of monsters/<id>.yaml.",
});

const setWorldFields = {
	name: text(24, "What the table calls them.", "Ada"),
	pronouns: Schema.optionalKey(text(40, "Their pronouns.", "they/them")),
	concept: Schema.optionalKey(
		text(80, "Who they are, in a line.", "Lamplighter")
	),
	seed: Schema.optionalKey(
		Schema.Int.check(
			Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
		).annotate({
			description: "The set.world seed to roll them from.",
		})
	),
	tags: Schema.optionalKey(Tags),
	portrait: freeformFields.portrait,
};

export const SetWorldPartySchema = Schema.Struct({
	...setWorldFields,
	...refFields,
}).annotate({
	identifier: "SetWorldPartyFront",
	title: "party/*.md (set-world)",
	description:
		"A set.world party member: rolled at set.world at the table, with their story here.",
});

export const SetWorldMonsterSchema = Schema.Struct(setWorldFields).annotate({
	identifier: "SetWorldMonsterFront",
	title: "monsters/*.md (set-world)",
	description:
		"A set.world foe: rolled at set.world at the table, with their story here.",
});

export const partySchemaFor = (rules: RulesetName) => {
	switch (rules) {
		case "draw-steel": {
			return DrawSteelPartySchema;
		}

		case "pf2e": {
			return Pf2ePartySchema;
		}

		case "set-world": {
			return SetWorldPartySchema;
		}

		case "freeform": {
			return FreeformPartySchema;
		}

		default: {
			return FreeformPartySchema;
		}
	}
};

export const monsterSchemaFor = (rules: RulesetName) => {
	switch (rules) {
		case "draw-steel": {
			return DrawSteelMonsterSchema;
		}

		case "pf2e": {
			return Pf2eMonsterSchema;
		}

		case "set-world": {
			return SetWorldMonsterSchema;
		}

		case "freeform": {
			return FreeformMonsterSchema;
		}

		default: {
			return FreeformMonsterSchema;
		}
	}
};
