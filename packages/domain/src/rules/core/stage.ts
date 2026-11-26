import { Equal, Schema } from "effect";

import { MapGridSchema } from "../../external/content.ts";
import { ifDefined, orEmpty } from "../../present.ts";
import { proseBytes, proseSafe, ProseSchema } from "../../prose.ts";
import type { Prose } from "../../prose.ts";
import { cleanText, hasTerminalControls, lengthOf, quote } from "../../text.ts";
import { MAP_HEIGHT, MAP_WIDTH, malformed } from "../board/grid.ts";
import { pick } from "../drawSteel/state.ts";
import { decodePayload, isRefused, refuse } from "../engine.ts";
import type { Decision, Envelope, Refused } from "../engine.ts";
import type { HostFact, HostNeed } from "../hostFacts.ts";
import type { CommandSpec, FeedFormat, FeedNote } from "./module.ts";

export const CARD_KINDS = [
	"scene",
	"npc",
	"handout",
	"item",
	"ancestry",
	"class",
	"ability",
	"party",
	"monster",
] as const;

export type CardKind = (typeof CARD_KINDS)[number];

export const CARD_KEY = new RegExp(
	`^(?<kind>${CARD_KINDS.join("|")}):(?<id>[a-z0-9][a-z0-9-]{0,39})$`,
	"u"
);

export const TITLE_MAX = 80;

export const BODY_BYTES = 8 * 1024;

export const READ_ALOUD_BYTES = 4 * 1024;

export const ART_LINES = 40;

export const ART_COLUMNS = 80;

export const PINNED_MAX = 6;

export const RECAP_MAX = 50;

export const RECAP_TEXT_MAX = 500;

export const TRACKERS_MAX = 12;

export const CARDS_MAX = 200;

export const TRACKER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/u;

export const TRACKER_KINDS = ["clock", "counter", "quest"] as const;

export type TrackerKind = (typeof TRACKER_KINDS)[number];

export const TRACKER_LIMIT = 999;

export const StageCardSchema = Schema.Struct({
	key: Schema.String,
	kind: Schema.Literals(CARD_KINDS),
	title: Schema.String,
	subtitle: Schema.optionalKey(Schema.String),
	readAloud: Schema.optionalKey(ProseSchema),
	body: ProseSchema,
	art: Schema.optionalKey(Schema.Array(Schema.String)),
	map: Schema.optionalKey(MapGridSchema),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({
	identifier: "StageCard",
	description:
		"One piece of the campaign shown at the table: its player-safe text, art and map, never its GM notes.",
});

export type StageCard = typeof StageCardSchema.Type;

export const TrackerSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(TRACKER_KINDS),
	value: Schema.Int,
	max: Schema.optionalKey(Schema.Int),
	tier: Schema.Literals(["gm-only", "revealed"]),
});

export type Tracker = typeof TrackerSchema.Type;

export type Tier = "revealed" | "on-table";

export type StageMode = "campaign" | "encounter";

export interface StagedCard {
	readonly card: StageCard;
	readonly tier: Tier;
	readonly since: number;
}

export interface Recap {
	readonly seq: number;
	readonly text: string;
}

export interface StageState {
	readonly cards: Readonly<Record<string, StagedCard>>;
	readonly scene?: string;
	readonly trackers: ReadonlyArray<Tracker>;
	readonly recap: ReadonlyArray<Recap>;
	readonly override?: { readonly mode: StageMode; readonly combat: boolean };
}

export const initialStage: StageState = { cards: {}, trackers: [], recap: [] };

const Mode = Schema.Literals(["campaign", "encounter", "auto"]);

export const StagePayloads = {
	"core.stage-mode-set": Schema.Struct({ mode: Mode }),
	"core.stage-pinned": Schema.Struct({ card: StageCardSchema }),
	"core.stage-unpinned": Schema.Struct({ key: Schema.String }),
	"core.card-revealed": Schema.Struct({ card: StageCardSchema }),
	"core.card-hidden": Schema.Struct({ key: Schema.String }),
	"core.tracker-set": Schema.Struct({ tracker: TrackerSchema }),
	"core.tracker-removed": Schema.Struct({ id: Schema.String }),
	"core.recap-added": Schema.Struct({ text: Schema.String }),
	"core.content-synced": Schema.Struct({
		cards: Schema.Array(StageCardSchema),
	}),
} as const;

export type StageEventType = keyof typeof StagePayloads;

const isStageEventType = (type: string): type is StageEventType =>
	Object.hasOwn(StagePayloads, type);

export const STAGE_EVENTS: ReadonlyArray<StageEventType> =
	Object.keys(StagePayloads).filter(isStageEventType);

export type StageModeWord = "campaign" | "encounter" | "auto";

export type TrackerAction = "set" | "show" | "hide" | "remove";

export type StageCommand =
	| { readonly type: "stage"; readonly mode: StageModeWord }
	| { readonly type: "show"; readonly ref: string; readonly card?: StageCard }
	| { readonly type: "unpin"; readonly ref: string }
	| {
			readonly type: "reveal";
			readonly ref: string;
			readonly card?: StageCard;
	  }
	| { readonly type: "hide"; readonly ref: string }
	| {
			readonly type: "tracker";
			readonly id: string;
			readonly action: TrackerAction;
			readonly kind?: TrackerKind;
			readonly label?: string;
			readonly max?: number;
			readonly value?: number;
	  }
	| {
			readonly type: "tick";
			readonly id: string;
			readonly op: "add" | "set";
			readonly amount: number;
	  }
	| { readonly type: "recap"; readonly text: string }
	| {
			readonly type: "sync";
			readonly ref?: string;
			readonly cards?: ReadonlyArray<StageCard>;
	  };

export const stageFormats = {
	stage: { speaker: false, separator: "" },
	recap: { speaker: false, separator: "" },
} as const satisfies Readonly<Record<string, FeedFormat>>;

const textOk = (text: string | undefined, max: number): boolean =>
	text === undefined ||
	(text.trim() !== "" && lengthOf(text) <= max && !hasTerminalControls(text));

const proseOk = (prose: Prose | undefined, bytes: number): boolean =>
	prose === undefined || (proseSafe(prose) && proseBytes(prose) <= bytes);

const artOk = (art: ReadonlyArray<string> | undefined): boolean =>
	art === undefined ||
	(art.length <= ART_LINES &&
		art.every(
			(line) => lengthOf(line) <= ART_COLUMNS && !hasTerminalControls(line)
		));

export const cardProblem = (card: StageCard): string | undefined => {
	const parts = CARD_KEY.exec(card.key)?.groups;

	if (parts === undefined || parts.kind !== card.kind) {
		return `'${quote(card.key)}' isn't a card's key, like npc:mara`;
	}

	if (!textOk(card.title, TITLE_MAX) || !textOk(card.subtitle, TITLE_MAX)) {
		return `a card's title and subtitle are text of at most ${TITLE_MAX} characters`;
	}

	if (!proseOk(card.body, BODY_BYTES)) {
		return `a card's text must be plain and within ${BODY_BYTES / 1024} KB`;
	}

	if (!proseOk(card.readAloud, READ_ALOUD_BYTES)) {
		return `a card's read-aloud must be plain and within ${READ_ALOUD_BYTES / 1024} KB`;
	}

	if (!artOk(card.art)) {
		return `a card's art is at most ${ART_LINES} lines of ${ART_COLUMNS} columns, plain`;
	}

	const tags = orEmpty(card.tags);

	if (tags.length > 12 || !tags.every((t) => textOk(t, 24))) {
		return "a card has at most 12 tags of 24 characters";
	}

	const grid = card.map;

	if (grid !== undefined) {
		const why = malformed(grid);

		if (why !== undefined) {
			return `a card's map is no good: ${why}`;
		}

		if (
			(grid.terrain[0]?.length ?? 0) > MAP_WIDTH ||
			grid.terrain.length > MAP_HEIGHT
		) {
			return `a card's map is at most ${MAP_WIDTH} columns by ${MAP_HEIGHT} rows`;
		}
	}

	return undefined;
};

const trackerProblem = (t: Tracker): string | undefined => {
	if (!TRACKER_ID.test(t.id)) {
		return `'${quote(t.id)}' isn't a tracker's id (lower-case letters, digits and hyphens, at most 24)`;
	}

	if (!textOk(t.label, 40)) {
		return "a tracker's label is text of at most 40 characters";
	}

	if (t.max !== undefined && (t.max < 1 || t.max > TRACKER_LIMIT)) {
		return `a tracker's most is 1 to ${TRACKER_LIMIT}`;
	}

	const top = t.max ?? TRACKER_LIMIT;

	return t.value < 0 || t.value > top
		? `a tracker's value is 0 to ${top}`
		: undefined;
};

export const pinnedOf = (slice: StageState): ReadonlyArray<StagedCard> =>
	Object.values(slice.cards).filter(
		(s) => s.tier === "on-table" && s.card.key !== slice.scene
	);

export const stagedRef = (
	slice: StageState,
	typed: string
): StagedCard | Refused => {
	const staged = Object.values(slice.cards);

	return pick(
		staged,
		(s) => [s.card.key, s.card.key.slice(s.card.kind.length + 1), s.card.title],
		(s) => s.card.key,
		typed,
		`Nothing called '${quote(typed)}' is on the stage or in the codex.`
	);
};

const SPACES = /\s+/u;

const words = (args: string): Array<string> =>
	args
		.trim()
		.split(SPACES)
		.filter((w) => w !== "");

const usage = (text: string): Refused => refuse(`Usage: ${text}`);

const one = (
	name: string,
	text: string,
	make: (ref: string) => StageCommand
): CommandSpec<StageCommand, StageState> => ({
	name,
	usage: `/${name} <${text}>`,
	summary: "",
	gmOnly: true,
	parse: (args) => {
		const [ref, extra] = words(args);

		return ref === undefined || extra !== undefined
			? usage(`/${name} <${text}>`)
			: make(ref);
	},
});

const stagedKeys = (slice: StageState, partial: string): Array<string> => {
	const typed = partial.trim().toLowerCase();

	return Object.keys(slice.cards).filter(
		(key) =>
			key.startsWith(typed) || key.slice(key.indexOf(":") + 1).startsWith(typed)
	);
};

const MODES: ReadonlyArray<StageModeWord> = ["campaign", "encounter", "auto"];

const isMode = (word: string): word is StageModeWord =>
	word === "campaign" || word === "encounter" || word === "auto";

const isTrackerKind = (word: string): word is TrackerKind =>
	word === "clock" || word === "counter" || word === "quest";

const WHOLE = /^\d{1,3}$/u;

const START = /^=(?<n>\d{1,3})$/u;

const LABEL_MARK = "--";

const AMOUNT = /^(?<op>[+=-])?(?<n>\d{1,3})$/u;

const TRACKER_USAGE =
	"/tracker <id> clock|counter|quest [max] [=start] [--] <label> | /tracker <id> show|hide|remove";

interface TrackerWords {
	readonly max?: number;
	readonly start?: number;
	readonly label: string;
}

const trackerWords = (rest: ReadonlyArray<string>): TrackerWords => {
	const [first] = rest;
	const counted = first !== undefined && WHOLE.test(first);
	const afterMax = counted ? rest.slice(1) : rest;
	const start = START.exec(afterMax[0] ?? "")?.groups?.n;
	const afterStart = start === undefined ? afterMax : afterMax.slice(1);
	const marked = afterStart[0] === LABEL_MARK;

	return {
		...ifDefined(counted ? Number(first) : undefined, (max) => ({ max })),
		...ifDefined(start === undefined ? undefined : Number(start), (value) => ({
			start: value,
		})),
		label: (marked ? afterStart.slice(1) : afterStart).join(" "),
	};
};

const parseTracker = (args: string): StageCommand | Refused => {
	const [id, word, ...rest] = words(args);

	if (id === undefined || word === undefined) {
		return usage(TRACKER_USAGE);
	}

	const lower = word.toLowerCase();

	if (lower === "show" || lower === "hide" || lower === "remove") {
		return rest.length === 0
			? { type: "tracker", id: id.toLowerCase(), action: lower }
			: usage(TRACKER_USAGE);
	}

	if (!isTrackerKind(lower)) {
		return usage(TRACKER_USAGE);
	}

	const { max, start, label } = trackerWords(rest);

	if (label === "" && max === undefined && start === undefined) {
		return usage(TRACKER_USAGE);
	}

	return {
		type: "tracker",
		id: id.toLowerCase(),
		action: "set",
		kind: lower,
		label: label === "" ? id : label,
		...ifDefined(max, (value) => ({ max: value })),
		...ifDefined(start, (value) => ({ value })),
	};
};

const OPTION_LIKE = /^(?:\d|=|--(?:\s|$))/u;

export const trackerLabelWords = (label: string): string =>
	OPTION_LIKE.test(label.trim()) ? `${LABEL_MARK} ${label}` : label;

export const stageCommands: Readonly<
	Record<StageCommand["type"], CommandSpec<StageCommand, StageState>>
> = {
	stage: {
		name: "stage",
		usage: "/stage campaign|encounter|auto",
		summary:
			"Show the campaign stage or the encounter, or follow the fight again (auto); a choice lasts until a fight starts or ends.",
		gmOnly: true,
		parse: (args) => {
			const word = args.trim().toLowerCase();

			return isMode(word)
				? { type: "stage", mode: word }
				: usage("/stage campaign|encounter|auto");
		},
		complete: (_slice, partial) =>
			MODES.filter((m) => m.startsWith(partial.trim().toLowerCase())),
	},
	show: {
		...one("show", "card", (ref) => ({ type: "show", ref })),
		summary: `Put a card on the table for everyone: a scene becomes the scene, others pin (at most ${PINNED_MAX}).`,
	},
	unpin: {
		...one("unpin", "card", (ref) => ({ type: "unpin", ref })),
		summary: "Take a card off the table; it stays in the players' codex.",
		complete: (slice, partial) =>
			stagedKeys(slice, partial).filter(
				(key) => slice.cards[key]?.tier === "on-table"
			),
	},
	reveal: {
		...one("reveal", "card", (ref) => ({ type: "reveal", ref })),
		summary:
			"Add a card to the players' codex without putting it on the table.",
	},
	hide: {
		...one("hide", "card", (ref) => ({ type: "hide", ref })),
		summary: "Take a card back from the table and the codex: GM-only again.",
		complete: (slice, partial) => stagedKeys(slice, partial),
	},
	tracker: {
		name: "tracker",
		usage: TRACKER_USAGE,
		summary:
			"Set up a clock, counter or quest (for your eyes until you show it), or show, hide or remove one.",
		gmOnly: true,
		parse: parseTracker,
		complete: (slice, partial) =>
			slice.trackers
				.map((t) => t.id)
				.filter((id) => id.startsWith(partial.trim().toLowerCase())),
	},
	tick: {
		name: "tick",
		usage: "/tick <tracker> [+n|-n|=n]",
		summary: "Move a tracker on by one, or by n, or set it.",
		gmOnly: true,
		parse: (args) => {
			const [id, change, extra] = words(args);
			const amount = AMOUNT.exec(change ?? "+1")?.groups;

			if (id === undefined || amount === undefined || extra !== undefined) {
				return usage("/tick <tracker> [+n|-n|=n]");
			}

			const n = Number(amount.n);

			return {
				type: "tick",
				id: id.toLowerCase(),
				op: amount.op === "=" ? "set" : "add",
				amount: amount.op === "-" ? -n : n,
			};
		},
		complete: (slice, partial) =>
			slice.trackers
				.map((t) => t.id)
				.filter((id) => id.startsWith(partial.trim().toLowerCase())),
	},
	recap: {
		name: "recap",
		usage: "/recap <text>",
		summary: "Add a line to the session's recap, which everyone sees.",
		gmOnly: true,
		parse: (args) =>
			cleanText(args) === ""
				? usage("/recap <text>")
				: { type: "recap", text: args },
	},
	sync: {
		name: "sync",
		usage: "/sync [card]",
		summary:
			"Read the cards on the stage again from the campaign's files, after you edit them.",
		gmOnly: true,
		parse: (args) => {
			const [ref, extra] = words(args);

			if (extra !== undefined) {
				return usage("/sync [card]");
			}

			return ref === undefined ? { type: "sync" } : { type: "sync", ref };
		},
		complete: (slice, partial) => stagedKeys(slice, partial),
	},
};

export const isStageCommandType = (
	type: string
): type is StageCommand["type"] => Object.hasOwn(stageCommands, type);

export const stageHostNeed = (command: StageCommand): HostNeed | undefined => {
	if (
		(command.type === "show" || command.type === "reveal") &&
		command.card === undefined
	) {
		return { kind: "card", query: command.ref };
	}

	return command.type === "sync" && command.cards === undefined
		? { kind: "cards", ...ifDefined(command.ref, (ref) => ({ ref })) }
		: undefined;
};

export const stageFillHostFact = (
	command: StageCommand,
	fact: HostFact
): StageCommand => {
	if (
		(command.type === "show" || command.type === "reveal") &&
		fact.kind === "card"
	) {
		return { ...command, card: fact.card };
	}

	return command.type === "sync" && fact.kind === "cards"
		? { ...command, cards: fact.cards }
		: command;
};

export const modeOf = (slice: StageState, combat: boolean): StageMode => {
	const { override } = slice;

	if (override !== undefined && override.combat === combat) {
		return override.mode;
	}

	return combat ? "encounter" : "campaign";
};

const decided = <T extends StageEventType>(
	type: T,
	payload: (typeof StagePayloads)[T]["Type"]
): Decision => ({
	events: [{ type, payload }],
});

const checkedCard = (
	card: StageCard | undefined,
	ref: string
): StageCard | Refused => {
	if (card === undefined) {
		return refuse(`No card for '${quote(ref)}' was found.`);
	}

	const problem = cardProblem(card);

	return problem === undefined ? card : refuse(`${card.key}: ${problem}.`);
};

const show = (
	slice: StageState,
	command: Extract<StageCommand, { readonly type: "show" }>
): Decision => {
	const card = checkedCard(command.card, command.ref);

	if (isRefused(card)) {
		return card;
	}

	const was = slice.cards[card.key];

	if (
		was?.tier === "on-table" &&
		(card.kind !== "scene" || slice.scene === card.key)
	) {
		return refuse(`${card.title} is on the table already.`);
	}

	if (card.kind !== "scene" && pinnedOf(slice).length >= PINNED_MAX) {
		return refuse(
			`The table holds at most ${PINNED_MAX} cards: /unpin one first.`
		);
	}

	if (was === undefined && Object.keys(slice.cards).length >= CARDS_MAX) {
		return refuse(
			`The codex holds at most ${CARDS_MAX} cards: /hide some first.`
		);
	}

	return decided("core.stage-pinned", { card });
};

const reveal = (
	slice: StageState,
	command: Extract<StageCommand, { readonly type: "reveal" }>
): Decision => {
	const card = checkedCard(command.card, command.ref);

	if (isRefused(card)) {
		return card;
	}

	const was = slice.cards[card.key];

	if (was !== undefined) {
		return refuse(
			was.tier === "on-table"
				? `${card.title} is on the table already.`
				: `${card.title} is in the codex already.`
		);
	}

	if (Object.keys(slice.cards).length >= CARDS_MAX) {
		return refuse(
			`The codex holds at most ${CARDS_MAX} cards: /hide some first.`
		);
	}

	return decided("core.card-revealed", { card });
};

const trackerNamed = (slice: StageState, id: string): Tracker | undefined =>
	slice.trackers.find((t) => t.id === id);

const changeTracker = (
	slice: StageState,
	command: Extract<StageCommand, { readonly type: "tracker" }>
): Decision => {
	const was = trackerNamed(slice, command.id);

	if (command.action === "set") {
		if (command.kind === undefined) {
			return usage(TRACKER_USAGE);
		}

		if (was === undefined && slice.trackers.length >= TRACKERS_MAX) {
			return refuse(`The stage holds at most ${TRACKERS_MAX} trackers.`);
		}

		const label = cleanText(command.label ?? command.id);

		const tracker: Tracker = {
			id: command.id,
			label,
			kind: command.kind,
			value:
				command.value ??
				Math.min(was?.value ?? 0, command.max ?? TRACKER_LIMIT),
			...ifDefined(command.max, (max) => ({ max })),
			tier: was?.tier ?? "gm-only",
		};

		const problem = trackerProblem(tracker);

		return problem === undefined
			? decided("core.tracker-set", { tracker })
			: refuse(`${problem}.`);
	}

	if (was === undefined) {
		return refuse(`There's no tracker '${quote(command.id)}'.`);
	}

	if (command.action === "remove") {
		return decided("core.tracker-removed", { id: was.id });
	}

	const tier = command.action === "show" ? "revealed" : "gm-only";

	return was.tier === tier
		? refuse(
				`${was.label} is ${tier === "revealed" ? "shown" : "hidden"} already.`
			)
		: decided("core.tracker-set", { tracker: { ...was, tier } });
};

const tick = (
	slice: StageState,
	command: Extract<StageCommand, { readonly type: "tick" }>
): Decision => {
	const was = trackerNamed(slice, command.id);

	if (was === undefined) {
		return refuse(`There's no tracker '${quote(command.id)}'.`);
	}

	const wanted =
		command.op === "set" ? command.amount : was.value + command.amount;

	const value = Math.max(0, Math.min(was.max ?? TRACKER_LIMIT, wanted));

	return value === was.value
		? refuse(`${was.label} is at ${value} already.`)
		: decided("core.tracker-set", { tracker: { ...was, value } });
};

const recap = (raw: string): Decision => {
	const text = cleanText(raw);

	if (text === "") {
		return usage("/recap <text>");
	}

	if (lengthOf(text) > RECAP_TEXT_MAX) {
		return refuse(`Keep a recap line to ${RECAP_TEXT_MAX} characters.`);
	}

	return decided("core.recap-added", { text });
};

const sync = (
	slice: StageState,
	command: Extract<StageCommand, { readonly type: "sync" }>
): Decision => {
	const known = (command.cards ?? []).filter(
		(c) => slice.cards[c.key] !== undefined
	);

	if (known.length === 0) {
		return refuse(
			Object.keys(slice.cards).length === 0
				? "No card is on the stage or in the codex to sync."
				: "None of those cards could be read again."
		);
	}

	const cards = known.filter((c) => !Equal.equals(slice.cards[c.key]?.card, c));

	if (cards.length === 0) {
		return refuse("Nothing changed.");
	}

	const bad = cards.find((c) => cardProblem(c) !== undefined);

	if (bad !== undefined) {
		return refuse(`${bad.key}: ${cardProblem(bad) ?? "no good"}.`);
	}

	return decided("core.content-synced", { cards });
};

export const decideStage = (
	slice: StageState,
	combat: boolean,
	command: StageCommand
): Decision => {
	switch (command.type) {
		case "stage": {
			if (command.mode === "auto") {
				return slice.override === undefined || slice.override.combat !== combat
					? refuse("The stage follows the fight already.")
					: decided("core.stage-mode-set", { mode: "auto" });
			}

			return modeOf(slice, combat) === command.mode
				? refuse(`The stage shows the ${command.mode} already.`)
				: decided("core.stage-mode-set", { mode: command.mode });
		}

		case "show": {
			return show(slice, command);
		}

		case "reveal": {
			return reveal(slice, command);
		}

		case "unpin": {
			const staged = stagedRef(slice, command.ref);

			if (isRefused(staged)) {
				return staged;
			}

			return staged.tier === "on-table"
				? decided("core.stage-unpinned", { key: staged.card.key })
				: refuse(`${staged.card.title} isn't on the table.`);
		}

		case "hide": {
			const staged = stagedRef(slice, command.ref);

			return isRefused(staged)
				? staged
				: decided("core.card-hidden", { key: staged.card.key });
		}

		case "tracker": {
			return changeTracker(slice, command);
		}

		case "tick": {
			return tick(slice, command);
		}

		case "recap": {
			return recap(command.text);
		}

		case "sync": {
			return sync(slice, command);
		}

		default: {
			return refuse("There is no such command.");
		}
	}
};

const bad: (envelope: Envelope, why: string) => never = (envelope, why) => {
	throw new Error(`${envelope.type} at seq ${envelope.seq} ${why}`);
};

const safeCard = (envelope: Envelope, card: StageCard): StageCard => {
	const problem = cardProblem(card);

	return problem === undefined
		? card
		: bad(envelope, `holds a card the table can't show: ${problem}`);
};

const KIND_NAMES: Readonly<Record<CardKind, string>> = {
	scene: "Scene",
	npc: "NPC",
	handout: "Handout",
	item: "Item",
	ancestry: "Ancestry",
	class: "Class",
	ability: "Ability",
	party: "Party",
	monster: "Creature",
};

const named = (card: StageCard) => `${KIND_NAMES[card.kind]}: ${card.title}`;

const note = (text: string): FeedNote => ({ kind: "stage", text });

export interface StageApplied {
	readonly slice: StageState;
	readonly feed?: FeedNote;
}

const withoutKey = (slice: StageState, key: string): StageState => {
	const { [key]: _gone, ...cards } = slice.cards;
	const { scene, ...rest } = slice;

	return {
		...rest,
		cards,
		...ifDefined(scene === key ? undefined : scene, (value) => ({
			scene: value,
		})),
	};
};

const pinned = (slice: StageState, envelope: Envelope): StageApplied => {
	const { card } = decodePayload(StagePayloads["core.stage-pinned"], envelope);
	safeCard(envelope, card);
	const scene = card.kind === "scene";

	if (
		!scene &&
		slice.cards[card.key]?.tier !== "on-table" &&
		pinnedOf(slice).length >= PINNED_MAX
	) {
		bad(envelope, `pins more than ${PINNED_MAX} cards`);
	}

	if (
		slice.cards[card.key] === undefined &&
		Object.keys(slice.cards).length >= CARDS_MAX
	) {
		bad(envelope, `holds more than ${CARDS_MAX} cards`);
	}

	const before = slice.scene;

	const prior =
		scene && before !== undefined && before !== card.key
			? slice.cards[before]
			: undefined;

	const cards = { ...slice.cards };

	if (prior !== undefined) {
		cards[prior.card.key] = { ...prior, tier: "revealed", since: envelope.seq };
	}

	cards[card.key] = { card, tier: "on-table", since: envelope.seq };

	return {
		slice: {
			...slice,
			cards,
			...ifDefined(scene ? card.key : slice.scene, (value) => ({
				scene: value,
			})),
		},
		feed: note(
			scene ? `The scene is ${card.title}.` : `On the table: ${named(card)}.`
		),
	};
};

const appliers: Readonly<
	Record<
		StageEventType,
		(slice: StageState, envelope: Envelope, combat: boolean) => StageApplied
	>
> = {
	"core.stage-mode-set": (slice, envelope, combat) => {
		const { mode } = decodePayload(
			StagePayloads["core.stage-mode-set"],
			envelope
		);

		const { override: _override, ...rest } = slice;

		if (mode === "auto") {
			return {
				slice: rest,
				feed: note(
					`The stage follows the fight: it shows the ${combat ? "encounter" : "campaign"}.`
				),
			};
		}

		return {
			slice: { ...rest, override: { mode, combat } },
			feed: note(`The stage shows the ${mode}.`),
		};
	},
	"core.stage-pinned": pinned,
	"core.stage-unpinned": (slice, envelope) => {
		const { key } = decodePayload(
			StagePayloads["core.stage-unpinned"],
			envelope
		);

		const staged = slice.cards[key];

		if (staged === undefined || staged.tier !== "on-table") {
			return bad(envelope, `unpins '${key}', which isn't on the table`);
		}

		const { scene, ...rest } = slice;

		return {
			slice: {
				...rest,
				cards: {
					...slice.cards,
					[key]: { ...staged, tier: "revealed", since: envelope.seq },
				},
				...ifDefined(scene === key ? undefined : scene, (value) => ({
					scene: value,
				})),
			},
			feed: note(`Off the table: ${named(staged.card)}.`),
		};
	},
	"core.card-revealed": (slice, envelope) => {
		const { card } = decodePayload(
			StagePayloads["core.card-revealed"],
			envelope
		);

		safeCard(envelope, card);

		if (slice.cards[card.key] !== undefined) {
			bad(envelope, `reveals '${card.key}' a second time`);
		}

		if (Object.keys(slice.cards).length >= CARDS_MAX) {
			bad(envelope, `holds more than ${CARDS_MAX} cards`);
		}

		return {
			slice: {
				...slice,
				cards: {
					...slice.cards,
					[card.key]: { card, tier: "revealed", since: envelope.seq },
				},
			},
			feed: note(`In the codex: ${named(card)}.`),
		};
	},
	"core.card-hidden": (slice, envelope) => {
		const { key } = decodePayload(StagePayloads["core.card-hidden"], envelope);
		const staged = slice.cards[key];

		if (staged === undefined) {
			bad(envelope, `hides '${key}', which isn't shown`);
		}

		return {
			slice: withoutKey(slice, key),
			feed: note(`Put away: ${named(staged.card)}.`),
		};
	},
	"core.tracker-set": (slice, envelope) => {
		const { tracker } = decodePayload(
			StagePayloads["core.tracker-set"],
			envelope
		);

		const problem = trackerProblem(tracker);

		if (problem !== undefined) {
			bad(envelope, `holds a tracker the table can't show: ${problem}`);
		}

		const was = trackerNamed(slice, tracker.id);

		if (was === undefined && slice.trackers.length >= TRACKERS_MAX) {
			bad(envelope, `sets more than ${TRACKERS_MAX} trackers`);
		}

		const trackers =
			was === undefined
				? [...slice.trackers, tracker]
				: slice.trackers.map((t) => (t.id === tracker.id ? tracker : t));

		const of =
			tracker.max === undefined
				? `${tracker.value}`
				: `${tracker.value}/${tracker.max}`;

		const shown =
			tracker.tier === "revealed"
				? note(
						was?.tier === "gm-only" || was === undefined
							? `${tracker.label}: ${of}.`
							: `${tracker.label}: ${was.value} → ${of}.`
					)
				: undefined;

		return {
			slice: { ...slice, trackers },
			...ifDefined(shown, (feed) => ({ feed })),
		};
	},
	"core.tracker-removed": (slice, envelope) => {
		const { id } = decodePayload(
			StagePayloads["core.tracker-removed"],
			envelope
		);

		const was = trackerNamed(slice, id);

		if (was === undefined) {
			bad(envelope, `removes '${id}', which isn't a tracker`);
		}

		return {
			slice: { ...slice, trackers: slice.trackers.filter((t) => t.id !== id) },
			...ifDefined(
				was.tier === "revealed"
					? note(`${was.label} is done with.`)
					: undefined,
				(feed) => ({ feed })
			),
		};
	},
	"core.recap-added": (slice, envelope) => {
		const { text } = decodePayload(StagePayloads["core.recap-added"], envelope);

		if (!textOk(text, RECAP_TEXT_MAX)) {
			bad(envelope, "holds recap text the table can't show");
		}

		return {
			slice: {
				...slice,
				recap: [...slice.recap, { seq: envelope.seq, text }].slice(-RECAP_MAX),
			},
			feed: { kind: "recap", text: `Recap: ${text}` },
		};
	},
	"core.content-synced": (slice, envelope) => {
		const { cards } = decodePayload(
			StagePayloads["core.content-synced"],
			envelope
		);

		const [first] = cards;

		for (const card of cards) {
			safeCard(envelope, card);

			if (slice.cards[card.key] === undefined) {
				bad(envelope, `syncs '${card.key}', which isn't shown`);
			}
		}

		const fresh = Object.fromEntries(
			cards.flatMap((card) => {
				const was = slice.cards[card.key];

				return was === undefined ? [] : [[card.key, { ...was, card }] as const];
			})
		);

		return {
			slice: { ...slice, cards: { ...slice.cards, ...fresh } },
			feed: note(
				first !== undefined && cards.length === 1
					? `${named(first)} is read again.`
					: `${cards.length} cards are read again.`
			),
		};
	},
};

export const isStageEvent = (type: string): boolean => isStageEventType(type);

export const applyStage = (
	slice: StageState,
	envelope: Envelope,
	combat: boolean
): StageApplied => {
	if (!isStageEventType(envelope.type)) {
		throw new Error(`the stage can't apply "${envelope.type}"`);
	}

	return appliers[envelope.type](slice, envelope, combat);
};

export const afterCombat = (slice: StageState, combat: boolean): StageState => {
	if (slice.override === undefined || slice.override.combat === combat) {
		return slice;
	}

	const { override: _override, ...rest } = slice;

	return rest;
};
