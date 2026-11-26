import { parseNotation, signed } from "../../dice.ts";
import { ifDefined, orEmpty } from "../../present.ts";
import { hasTerminalControls, lengthOf } from "../../text.ts";
import { formatSquare, malformed, standable } from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import type { FeedNote } from "../core/module.ts";
import { ID } from "../drawSteel/schema.ts";
import { bad, isRefused, payloadDecoder } from "../engine.ts";
import type { Envelope } from "../engine.ts";
import { isEventType, Payloads } from "./events.ts";
import type { EventType } from "./events.ts";
import { ffSheetProblem, STAT_LIMIT, TAG, TAGS_MAX } from "./schema.ts";
import type { FfSheet } from "./schema.ts";
import { findFigure, maxOf, occupants, valueOf, valuesOf } from "./state.ts";
import type { FfFigure, FfOrder, FfState } from "./state.ts";

interface Applied {
	readonly slice: FfState;
	readonly feed?: FeedNote;
}

export const formats = {
	ff: { speaker: false, separator: "" },
	"ff-turn": { speaker: false, separator: "" },
	"ff-act": { speaker: true, separator: " " },
	"ff-claim": { speaker: true, separator: " ", plainLabel: true },
} as const;

const decode = payloadDecoder(Payloads);

const figure = (slice: FfState, envelope: Envelope, id: string): FfFigure =>
	findFigure(slice, id) ??
	bad(envelope, `names '${id}', who isn't at the table`);

const withFigure = (
	slice: FfState,
	id: string,
	f: (x: FfFigure) => FfFigure
): FfState => ({
	...slice,
	figures: slice.figures.map((x) => (x.id === id ? f(x) : x)),
});

const mapOf = (slice: FfState, envelope: Envelope) =>
	slice.map ?? bad(envelope, "comes with no map loaded");

const orderOf = (slice: FfState, envelope: Envelope): FfOrder =>
	slice.order ?? bad(envelope, "comes with no turns going");

const checkSheet = (envelope: Envelope, sheet: FfSheet) => {
	const problem = ffSheetProblem(sheet);

	if (problem !== undefined) {
		bad(envelope, `holds a sheet the table can't use: ${problem}`);
	}
};

const standOn = (
	slice: FfState,
	envelope: Envelope,
	id: string,
	at: Square
) => {
	if (!standable(mapOf(slice, envelope).terrain, at)) {
		bad(envelope, `puts '${id}' where nobody can stand`);
	}

	if (occupants(slice, id)(at) !== undefined) {
		bad(envelope, `puts '${id}' on someone`);
	}
};

const offTheMap = (slice: FfState): FfState["figures"] =>
	slice.figures.map(({ at: _at, ...f }) => f);

const joined = (sheet: FfSheet, was: FfFigure | undefined): FfFigure => ({
	id: sheet.id,
	name: sheet.name,
	side: "party",
	sheet,
	values: valuesOf(sheet, was),
	tags: was?.tags ?? [...orEmpty(sheet.tags)].map((t) => t.toLowerCase()),
	...ifDefined(was?.player, (player) => ({ player })),
	...ifDefined(was?.at, (at) => ({ at })),
});

const withoutId = (order: FfOrder, id: string): FfOrder | undefined => {
	const at = order.ids.indexOf(id);

	if (at === -1) {
		return order;
	}

	const ids = order.ids.filter((x) => x !== id);

	if (ids.length === 0) {
		return undefined;
	}

	return {
		...order,
		ids,
		turn: at <= order.turn ? order.turn - 1 : order.turn,
	};
};

const statLine = (f: FfFigure, key: string, value: number) => {
	const max = maxOf(f, key);

	return max === undefined ? `${value}` : `${value}/${max}`;
};

type Applier = (slice: FfState, envelope: Envelope) => Applied;

const appliers = {
	"ff.pc-joined": (slice, envelope) => {
		const { sheet } = decode("ff.pc-joined", envelope);
		checkSheet(envelope, sheet);
		const was = findFigure(slice, sheet.id);

		if (was !== undefined && was.side !== "party") {
			bad(envelope, `joins '${sheet.id}' to the party, a foe's id`);
		}

		const next = joined(sheet, was);
		const swapped = slice.figures.map((f) => (f.id === sheet.id ? next : f));
		const concept = sheet.concept === undefined ? "" : `, ${sheet.concept},`;

		return {
			slice: {
				...slice,
				figures: was === undefined ? [...slice.figures, next] : swapped,
			},
			feed: {
				kind: "ff",
				text:
					was === undefined
						? `${sheet.name}${concept} joins the party.`
						: `${sheet.name}'s sheet is loaded again.`,
			},
		};
	},
	"ff.figures-added": (slice, envelope) => {
		const { sheet, ids, names } = decode("ff.figures-added", envelope);
		checkSheet(envelope, sheet);

		if (ids.length !== names.length || ids.length > 12) {
			bad(envelope, "names its figures wrongly");
		}

		if (
			ids.some((id) => !ID.test(id) || findFigure(slice, id) !== undefined) ||
			new Set(ids).size !== ids.length
		) {
			bad(envelope, "brings an id that's taken or isn't one");
		}

		if (
			names.some(
				(n) => n.trim() === "" || lengthOf(n) > 48 || hasTerminalControls(n)
			)
		) {
			bad(envelope, "holds a name the table can't show");
		}

		const added = ids.map((id, i): FfFigure => ({
			id,
			name: names[i] ?? id,
			side: "foes",
			sheet,
			values: valuesOf(sheet),
			tags: [...orEmpty(sheet.tags)].map((t) => t.toLowerCase()),
		}));

		return {
			slice: { ...slice, figures: [...slice.figures, ...added] },
			feed: {
				kind: "ff",
				text:
					added.length === 1
						? `${names[0]} comes to the table.`
						: `${added.length} of ${sheet.name} come to the table: ${names.join(", ")}.`,
			},
		};
	},
	"ff.played": (slice, envelope) => {
		const { id, player } = decode("ff.played", envelope);
		const f = figure(slice, envelope, id);

		if (f.side !== "party") {
			bad(envelope, `gives a player '${id}', a foe`);
		}

		if (slice.figures.some((x) => x.player === player && x.id !== id)) {
			bad(envelope, "gives a player a second figure");
		}

		return {
			slice: withFigure(slice, id, (x) => ({ ...x, player })),
			feed: { kind: "ff-claim", text: `takes ${f.name}.`, speaker: player },
		};
	},
	"ff.unplayed": (slice, envelope) => {
		const { id } = decode("ff.unplayed", envelope);
		const f = figure(slice, envelope, id);

		if (f.player === undefined) {
			bad(envelope, `frees '${id}', whom nobody plays`);
		}

		return {
			slice: withFigure(slice, id, ({ player: _player, ...x }) => x),
			feed:
				f.player === envelope.actor
					? { kind: "ff-act", text: `stops playing ${f.name}.` }
					: { kind: "ff", text: `Nobody plays ${f.name} now.` },
		};
	},
	"ff.stat-set": (slice, envelope) => {
		const { id, key, value } = decode("ff.stat-set", envelope);
		const f = figure(slice, envelope, id);
		const was = valueOf(f, key);
		const max = maxOf(f, key);

		if (was === undefined) {
			bad(envelope, `sets '${key}', which ${f.name} hasn't`);
		}

		if (
			Math.abs(value) > STAT_LIMIT ||
			(max !== undefined && (value < 0 || value > max))
		) {
			bad(envelope, `puts ${key} out of its range`);
		}

		return {
			slice: withFigure(slice, id, (x) => ({
				...x,
				values: { ...x.values, [key]: value },
			})),
			feed: {
				kind: "ff",
				text: `${f.name}'s ${key}: ${was} → ${statLine(f, key, value)}.`,
			},
		};
	},
	"ff.tag-set": (slice, envelope) => {
		const { id, tag, on } = decode("ff.tag-set", envelope);
		const f = figure(slice, envelope, id);

		if (!TAG.test(tag) || f.tags.includes(tag) === on) {
			bad(envelope, `tags ${f.name} with '${tag}' wrongly`);
		}

		if (on && f.tags.length >= TAGS_MAX) {
			bad(envelope, "gives a figure too many tags");
		}

		return {
			slice: withFigure(slice, id, (x) => ({
				...x,
				tags: on ? [...x.tags, tag] : x.tags.filter((t) => t !== tag),
			})),
			feed: {
				kind: "ff",
				text: on ? `${f.name} is ${tag}.` : `${f.name} is no longer ${tag}.`,
			},
		};
	},
	"ff.checked": (slice, envelope) => {
		const p = decode("ff.checked", envelope);
		const f = figure(slice, envelope, p.id);
		const notation = parseNotation(p.notation);

		if (
			isRefused(notation) ||
			notation.text !== p.notation ||
			notation.count !== p.rolls.length ||
			p.rolls.some((r) => r < 1 || r > notation.sides) ||
			valueOf(f, p.stat) !== p.value ||
			p.rolls.reduce((a, b) => a + b, 0) + notation.modifier + p.value !==
				p.total
		) {
			bad(envelope, "doesn't add up");
		}

		return {
			slice,
			feed: {
				kind: "ff",
				text: `${f.name} checks ${p.stat}: ${p.notation} [${p.rolls.join(", ")}] ${signed(p.value) || "+0"} = ${p.total}.`,
			},
		};
	},
	"ff.map-loaded": (slice, envelope) => {
		const { id, name, terrain, dressing } = decode("ff.map-loaded", envelope);

		const why = malformed({
			name,
			terrain,
			...ifDefined(dressing, (value) => ({ dressing: value })),
		});

		if (why !== undefined) {
			bad(envelope, `has a bad grid: ${why}`);
		}

		return {
			slice: {
				...slice,
				figures: offTheMap(slice),
				map: {
					id,
					name,
					terrain,
					...ifDefined(dressing, (value) => ({ dressing: value })),
				},
			},
			feed: {
				kind: "ff",
				text: `The map is ${name}, ${terrain[0]?.length ?? 0} by ${terrain.length}.`,
			},
		};
	},
	"ff.map-cleared": (slice, envelope) => {
		decode("ff.map-cleared", envelope);
		mapOf(slice, envelope);
		const { map: _map, ...rest } = slice;

		return {
			slice: { ...rest, figures: offTheMap(slice) },
			feed: { kind: "ff", text: "The map is put away." },
		};
	},
	"ff.placed": (slice, envelope) => {
		const { id, at } = decode("ff.placed", envelope);
		const f = figure(slice, envelope, id);
		standOn(slice, envelope, id, at);

		return {
			slice: withFigure(slice, id, (x) => ({ ...x, at })),
			feed: { kind: "ff", text: `${f.name} is placed at ${formatSquare(at)}.` },
		};
	},
	"ff.moved": (slice, envelope) => {
		const { id, at } = decode("ff.moved", envelope);
		const f = figure(slice, envelope, id);

		if (f.at === undefined) {
			bad(envelope, `moves '${id}', who isn't on the map`);
		}

		standOn(slice, envelope, id, at);

		return {
			slice: withFigure(slice, id, (x) => ({ ...x, at })),
			feed: { kind: "ff", text: `${f.name} moves to ${formatSquare(at)}.` },
		};
	},
	"ff.removed": (slice, envelope) => {
		const { id } = decode("ff.removed", envelope);
		const f = figure(slice, envelope, id);

		const order =
			slice.order === undefined ? undefined : withoutId(slice.order, id);

		const { order: _order, ...rest } = slice;

		return {
			slice: {
				...rest,
				figures: slice.figures.filter((x) => x.id !== id),
				...ifDefined(order, (value) => ({ order: value })),
			},
			feed: { kind: "ff", text: `${f.name} leaves the table.` },
		};
	},
	"ff.order-started": (slice, envelope) => {
		const { ids } = decode("ff.order-started", envelope);

		if (slice.order !== undefined) {
			bad(envelope, "starts turns while they're going");
		}

		if (new Set(ids).size !== ids.length) {
			bad(envelope, "names someone twice");
		}

		const first = figure(slice, envelope, ids[0]);

		for (const id of ids) {
			figure(slice, envelope, id);
		}

		return {
			slice: { ...slice, order: { ids, turn: 0, round: 1 } },
			feed: {
				kind: "ff-turn",
				text: `Turns begin, round 1: ${ids.map((id) => findFigure(slice, id)?.name ?? id).join(", ")}. ${first.name} goes first.`,
			},
		};
	},
	"ff.turn-started": (slice, envelope) => {
		const { id } = decode("ff.turn-started", envelope);
		const order = orderOf(slice, envelope);

		if (order.ids[order.turn + 1] !== id) {
			bad(envelope, `isn't the turn the order gives next`);
		}

		const f = figure(slice, envelope, id);

		return {
			slice: { ...slice, order: { ...order, turn: order.turn + 1 } },
			feed: { kind: "ff-turn", text: `${f.name}'s turn.` },
		};
	},
	"ff.round-started": (slice, envelope) => {
		const { round } = decode("ff.round-started", envelope);
		const order = orderOf(slice, envelope);

		if (round !== order.round + 1) {
			bad(envelope, `starts round ${round} after round ${order.round}`);
		}

		const first = figure(slice, envelope, order.ids[0] ?? "");

		return {
			slice: { ...slice, order: { ...order, turn: 0, round } },
			feed: {
				kind: "ff-turn",
				text: `Round ${round}: ${first.name}'s turn.`,
			},
		};
	},
	"ff.order-ended": (slice, envelope) => {
		decode("ff.order-ended", envelope);
		const order = orderOf(slice, envelope);
		const { order: _order, ...rest } = slice;

		return {
			slice: rest,
			feed: {
				kind: "ff-turn",
				text: `Turns end after round ${order.round}.`,
			},
		};
	},
} as const satisfies Record<EventType, Applier>;

export const apply = (slice: FfState, envelope: Envelope): Applied => {
	if (!isEventType(envelope.type)) {
		throw new Error(`ff can't apply "${envelope.type}"`);
	}

	return appliers[envelope.type](slice, envelope);
};
