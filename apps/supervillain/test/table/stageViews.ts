import { ifDefined } from "@supervillain/domain";

import type {
	CodexEntry,
	PartyMember,
	PrepView,
	StageCardView,
	StageView,
} from "../../src/table/view.ts";

export const ambush: StageCardView = {
	key: "scene:ford-ambush",
	kind: "scene",
	title: "Ambush at the Ford",
	readAloud: [{ kind: "para", text: "The Ford Road runs down to the water." }],
	body: [
		{ kind: "para", text: "The road dips toward the ford." },
		{ kind: "list", ordered: false, items: ["a ruined wall", "brush"] },
	],
	tags: [],
	tier: "on-table",
	since: 3,
};

export const mara: StageCardView = {
	key: "npc:old-mara",
	kind: "npc",
	title: "Old Mara",
	subtitle: "Ferry-keeper",
	body: [{ kind: "para", text: "A wiry woman with a long pole." }],
	tags: ["local"],
	tier: "on-table",
	since: 4,
};

export const poster: StageCardView = {
	key: "handout:wanted-poster",
	kind: "handout",
	title: "A wanted poster",
	body: [
		{
			kind: "pre",
			lines: ["+-------+", "| WANTED |", "+-------+"],
		},
	],
	tags: [],
	tier: "revealed",
	since: 5,
};

export const sketch: StageCardView = {
	key: "handout:ford-sketch",
	kind: "handout",
	title: "A sketch of the ford",
	body: [],
	map: {
		name: "The Ford Road",
		terrain: ["..........", "....~~....", "..##......"],
	},
	tags: [],
	tier: "on-table",
	since: 6,
};

const entry = (card: StageCardView): CodexEntry => ({
	key: card.key,
	kind: card.kind,
	title: card.title,
	...ifDefined(card.subtitle, (subtitle) => ({ subtitle })),
	tier: card.tier,
	card,
});

export const campaignStage: StageView = {
	mode: "campaign",
	override: false,
	combat: false,
	scene: ambush,
	pinned: [mara, sketch],
	codex: [ambush, poster, mara, sketch].map(entry),
	trackers: [
		{
			id: "bandit-alarm",
			label: "The alarm",
			kind: "clock",
			value: 2,
			max: 4,
			hidden: false,
		},
	],
	recap: [
		{ seq: 1, text: "The caravan reached the ford." },
		{ seq: 2, text: "Mara waved, then didn't." },
	],
	party: [],
};

export const emptyStage: StageView = {
	mode: "campaign",
	override: false,
	combat: false,
	pinned: [],
	codex: [],
	trackers: [],
	recap: [],
	party: [],
};

export const brann: PartyMember = {
	id: "brann",
	name: "Brann",
	player: "Alice",
	mine: false,
	free: false,
	down: false,
	health: { label: "Stamina", value: 15, max: 20 },
	summary: "Censor 1 · recoveries 8/8",
	tags: ["judged"],
};

export const kesh: PartyMember = {
	id: "kesh",
	name: "Kesh",
	mine: true,
	free: false,
	down: false,
	health: { label: "Stamina", value: 4, max: 21 },
	summary: "Fury 1",
	tags: [],
};

export const emptyPrep: PrepView = {
	steps: [],
	maps: { items: [] },
	place: [],
	sections: [],
	start: { note: "load a map to begin" },
};
