import { parseNotation } from "../../dice.ts";
import { ifDefined } from "../../present.ts";
import { quote } from "../../text.ts";
import {
	checkGrid,
	formatSquare,
	NOT_GENERATED,
	terrainAt,
} from "../board/grid.ts";
import type { Square } from "../board/grid.ts";
import { cheapestPath, moverWalk } from "../board/movement.ts";
import { GM } from "../core/module.ts";
import { ID } from "../drawSteel/schema.ts";
import { isRefused, refuse, rollFace } from "../engine.ts";
import type { Decision, Dice, NewEvent, Refused } from "../engine.ts";
import type { FfCommand } from "./commands.ts";
import { event } from "./events.ts";
import { ffSheetProblem, STAT_LIMIT, TAG, TAGS_MAX } from "./schema.ts";
import {
	actingId,
	ADD_MAX,
	controls,
	DEFAULT_DICE,
	figureOf,
	findFigure,
	freeIds,
	mapSide,
	maxOf,
	occupants,
	resolveFigure,
	valueOf,
} from "./state.ts";
import type { FfFigure, FfState } from "./state.ts";

const NO_MAP = "No map is loaded; the GM loads one with /map.";

const NO_ORDER = "No turns are going; the GM starts them with /start.";

const decided = (...events: Array<NewEvent>): Decision => ({ events });

export const cantStand = (
	slice: FfState,
	square: Square,
	f: FfFigure
): string | undefined => {
	const named = formatSquare(square);
	const terrain = terrainAt(slice.map?.terrain ?? [], square);

	if (terrain === "wall") {
		return `${named} is a wall.`;
	}

	if (terrain === "outside") {
		return `${named} is outside the map.`;
	}

	const there = occupants(slice, f.id)(square);

	return there === undefined
		? undefined
		: `${named} is taken by ${findFigure(slice, there.id)?.name ?? there.id}.`;
};

const loadMap = (
	slice: FfState,
	command: Extract<FfCommand, { readonly type: "ff-map" }>
): Decision => {
	if (command.generate !== undefined) {
		return refuse(NOT_GENERATED);
	}

	if (command.id === undefined) {
		return slice.map === undefined
			? refuse("No map is loaded.")
			: decided(event("ff.map-cleared", {}));
	}

	if (!ID.test(command.id)) {
		return refuse(`'${quote(command.id)}' isn't a map id.`);
	}

	if (command.grid === undefined) {
		return refuse(`No map for '${quote(command.id)}' was loaded.`);
	}

	const grid = checkGrid(command.id, command.grid);

	if (isRefused(grid)) {
		return grid;
	}

	return decided(
		event("ff.map-loaded", {
			id: command.id,
			name: grid.name,
			terrain: [...grid.terrain],
			...ifDefined(grid.dressing, (value) => ({ dressing: [...value] })),
		})
	);
};

const joinPc = (
	slice: FfState,
	command: Extract<FfCommand, { readonly type: "ff-pc" }>
): Decision => {
	const { sheet } = command;

	if (sheet === undefined) {
		return refuse(`No sheet for '${quote(command.id)}' was loaded.`);
	}

	const was = findFigure(slice, sheet.id);

	if (was !== undefined && was.side !== "party") {
		return refuse(
			`${was.name} is one of the foes, and a party member needs an id of their own.`
		);
	}

	const problem = ffSheetProblem(sheet);

	return problem === undefined
		? decided(event("ff.pc-joined", { sheet }))
		: refuse(`party/${sheet.id}.md: ${problem}.`);
};

const addFigures = (
	slice: FfState,
	command: Extract<FfCommand, { readonly type: "ff-add" }>
): Decision => {
	const { sheet } = command;

	if (
		!Number.isInteger(command.count) ||
		command.count < 1 ||
		command.count > ADD_MAX
	) {
		return refuse(`Add 1 to ${ADD_MAX} at a time.`);
	}

	if (sheet === undefined) {
		return refuse(`No sheet for '${quote(command.monster)}' was loaded.`);
	}

	const problem = ffSheetProblem(sheet);

	if (problem !== undefined) {
		return refuse(`monsters/${sheet.id}.md: ${problem}.`);
	}

	const ids = freeIds(slice, sheet.id, command.count);
	const [first, ...rest] = ids;

	if (first === undefined || !ids.every((id) => ID.test(id))) {
		return refuse(`'${quote(sheet.id)}' is too long an id to number.`);
	}

	const named = (id: string) =>
		command.count === 1 && id === sheet.id
			? sheet.name
			: `${sheet.name} ${id.slice(sheet.id.length + 1)}`;

	return decided(
		event("ff.figures-added", {
			sheet,
			ids: [first, ...rest],
			names: [named(first), ...rest.map(named)],
		})
	);
};

const play = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-play" }>
): Decision => {
	if (actor === GM) {
		return refuse("The GM plays every figure already.");
	}

	const f = resolveFigure(slice, command.who);

	if (isRefused(f)) {
		return f;
	}

	if (f.side !== "party") {
		return refuse(`${f.name} is one of the foes.`);
	}

	if (f.player === actor) {
		return refuse(`You play ${f.name} already.`);
	}

	const holder = f.player;

	const left =
		holder !== undefined &&
		holder.startsWith("guest:") &&
		command.seated !== undefined &&
		!command.seated.includes(holder);

	if (holder !== undefined && !left) {
		return refuse(`Someone else plays ${f.name}.`);
	}

	const own = figureOf(slice, actor);

	return own === undefined
		? decided(event("ff.played", { id: f.id, player: actor }))
		: refuse(`You play ${own.name}; /unplay first.`);
};

const unplay = (
	slice: FfState,
	actor: string,
	who: string | undefined
): Decision => {
	if (who === undefined) {
		const own = figureOf(slice, actor);

		if (own === undefined) {
			return refuse(
				actor === GM ? "Usage: /unplay <who>" : "You don't play anyone."
			);
		}

		return decided(event("ff.unplayed", { id: own.id }));
	}

	const f = resolveFigure(slice, who);

	if (isRefused(f)) {
		return f;
	}

	if (f.player === undefined) {
		return refuse(`Nobody plays ${f.name}.`);
	}

	return actor === GM || f.player === actor
		? decided(event("ff.unplayed", { id: f.id }))
		: refuse(`You don't play ${f.name}.`);
};

const yours = (
	slice: FfState,
	actor: string,
	who: string
): FfFigure | Refused => {
	const f = resolveFigure(slice, who);

	if (isRefused(f)) {
		return f;
	}

	return controls(actor, f) ? f : refuse(`You don't play ${f.name}.`);
};

const setStat = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-stat" }>
): Decision => {
	const f = yours(slice, actor, command.who);

	if (isRefused(f)) {
		return f;
	}

	const was = valueOf(f, command.key);

	if (was === undefined) {
		const keys = Object.keys(f.values);

		return refuse(
			`${f.name} has no ${command.key}${keys.length === 0 ? "." : `; there are: ${keys.join(", ")}.`}`
		);
	}

	const max = maxOf(f, command.key);
	const wanted = command.op === "set" ? command.amount : was + command.amount;

	const value =
		max === undefined
			? Math.max(-STAT_LIMIT, Math.min(STAT_LIMIT, wanted))
			: Math.max(0, Math.min(max, wanted));

	return value === was
		? refuse(`${f.name}'s ${command.key} is ${was} already.`)
		: decided(event("ff.stat-set", { id: f.id, key: command.key, value }));
};

const setTag = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-tag" }>
): Decision => {
	const f = yours(slice, actor, command.who);

	if (isRefused(f)) {
		return f;
	}

	if (!TAG.test(command.tag)) {
		return refuse(
			`'${quote(command.tag)}' isn't a tag: lower-case letters, digits and hyphens, at most 24.`
		);
	}

	const has = f.tags.includes(command.tag);

	if (has === command.on) {
		return refuse(
			`${f.name} ${has ? "is" : "isn't"} tagged ${command.tag} already.`
		);
	}

	if (command.on && f.tags.length >= TAGS_MAX) {
		return refuse(`${f.name} has the most tags a figure can.`);
	}

	return decided(
		event("ff.tag-set", { id: f.id, tag: command.tag, on: command.on })
	);
};

const checker = (
	slice: FfState,
	actor: string,
	who: string | undefined
): FfFigure | Refused => {
	if (who !== undefined) {
		return yours(slice, actor, who);
	}

	const own = figureOf(slice, actor);

	if (own !== undefined) {
		return own;
	}

	return refuse(
		actor === GM
			? "Usage: /check <who> <stat> [dice]"
			: "You don't play anyone; /play someone first."
	);
};

const check = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-check" }>,
	dice: Dice
): Decision => {
	const f = checker(slice, actor, command.who);

	if (isRefused(f)) {
		return f;
	}

	const value = valueOf(f, command.stat);

	if (value === undefined) {
		return refuse(`${f.name} has no ${command.stat}.`);
	}

	const notation = parseNotation(command.dice ?? f.sheet.dice ?? DEFAULT_DICE);

	if (isRefused(notation)) {
		return notation;
	}

	const rolls = Array.from({ length: notation.count }, () =>
		rollFace(dice, notation.sides)
	);

	const total = rolls.reduce((a, b) => a + b, 0) + notation.modifier + value;

	return decided(
		event("ff.checked", {
			id: f.id,
			stat: command.stat,
			value,
			notation: notation.text,
			rolls,
			total,
		})
	);
};

const place = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-place" }>
): Decision => {
	if (slice.map === undefined) {
		return refuse(NO_MAP);
	}

	const f = yours(slice, actor, command.who);

	if (isRefused(f)) {
		return f;
	}

	const why = cantStand(slice, command.at, f);

	return why === undefined
		? decided(event("ff.placed", { id: f.id, at: command.at }))
		: refuse(why);
};

const move = (
	slice: FfState,
	actor: string,
	command: Extract<FfCommand, { readonly type: "ff-move" }>
): Decision => {
	const { map } = slice;

	if (map === undefined) {
		return refuse(NO_MAP);
	}

	const f = yours(slice, actor, command.who);

	if (isRefused(f)) {
		return f;
	}

	if (f.at === undefined) {
		return refuse(`${f.name} isn't on the map; /place them first.`);
	}

	const named = formatSquare(command.to);

	if (f.at.x === command.to.x && f.at.y === command.to.y) {
		return refuse(`${f.name} is on ${named} already.`);
	}

	const why = cantStand(slice, command.to, f);

	if (why !== undefined) {
		return refuse(why);
	}

	const path = cheapestPath(
		map.terrain,
		f.at,
		command.to,
		moverWalk(
			map.terrain,
			{ side: mapSide(f), prone: false },
			occupants(slice, f.id)
		)
	);

	return path === undefined
		? refuse(`${f.name} can't get to ${named}.`)
		: decided(event("ff.moved", { id: f.id, at: command.to }));
};

const removeFigure = (slice: FfState, who: string): Decision => {
	const f = resolveFigure(slice, who);

	return isRefused(f) ? f : decided(event("ff.removed", { id: f.id }));
};

const startOrder = (slice: FfState, who: ReadonlyArray<string>): Decision => {
	if (slice.order !== undefined) {
		return refuse("Turns are going already; /end ends them.");
	}

	const named = who.map((typed) => resolveFigure(slice, typed));
	const missing = named.find(isRefused);

	if (missing !== undefined) {
		return missing;
	}

	const chosen = named.filter((f): f is FfFigure => !isRefused(f));

	const everyone = [
		...slice.figures.filter((f) => f.side === "party"),
		...slice.figures.filter((f) => f.side !== "party"),
	];

	const ids = [
		...new Set((who.length === 0 ? everyone : chosen).map((f) => f.id)),
	];

	const [first, ...rest] = ids;

	return first === undefined
		? refuse("Nobody is at the table to take turns: /pc and /add first.")
		: decided(event("ff.order-started", { ids: [first, ...rest] }));
};

const nextTurn = (slice: FfState, actor: string): Decision => {
	const { order } = slice;

	if (order === undefined) {
		return refuse(NO_ORDER);
	}

	const acting = actingId(order);
	const f = acting === undefined ? undefined : findFigure(slice, acting);

	if (actor !== GM && (f === undefined || !controls(actor, f))) {
		return refuse(
			f === undefined
				? "Only the GM can move the turns on now."
				: `It's ${f.name}'s turn, not yours to end.`
		);
	}

	const following = order.ids[order.turn + 1];

	return following === undefined
		? decided(event("ff.round-started", { round: order.round + 1 }))
		: decided(event("ff.turn-started", { id: following }));
};

type Handler = (
	slice: FfState,
	actor: string,
	command: FfCommand,
	dice: Dice
) => Decision;

const isType = <T extends FfCommand["type"]>(
	command: FfCommand,
	type: T
): command is Extract<FfCommand, { readonly type: T }> => command.type === type;

const by =
	<T extends FfCommand["type"]>(
		type: T,
		run: (
			slice: FfState,
			actor: string,
			command: Extract<FfCommand, { readonly type: T }>,
			dice: Dice
		) => Decision
	): Handler =>
	(slice, actor, command, dice) =>
		isType(command, type)
			? run(slice, actor, command, dice)
			: refuse(`There is no "${command.type}" command.`);

const HANDLERS = {
	"ff-pc": by("ff-pc", (slice, _actor, command) => joinPc(slice, command)),
	"ff-add": by("ff-add", (slice, _actor, command) =>
		addFigures(slice, command)
	),
	"ff-play": by("ff-play", (slice, actor, command) =>
		play(slice, actor, command)
	),
	"ff-unplay": by("ff-unplay", (slice, actor, command) =>
		unplay(slice, actor, command.who)
	),
	"ff-stat": by("ff-stat", (slice, actor, command) =>
		setStat(slice, actor, command)
	),
	"ff-tag": by("ff-tag", (slice, actor, command) =>
		setTag(slice, actor, command)
	),
	"ff-check": by("ff-check", (slice, actor, command, dice) =>
		check(slice, actor, command, dice)
	),
	"ff-map": by("ff-map", (slice, _actor, command) => loadMap(slice, command)),
	"ff-place": by("ff-place", (slice, actor, command) =>
		place(slice, actor, command)
	),
	"ff-move": by("ff-move", (slice, actor, command) =>
		move(slice, actor, command)
	),
	"ff-remove": by("ff-remove", (slice, _actor, command) =>
		removeFigure(slice, command.who)
	),
	"ff-start": by("ff-start", (slice, _actor, command) =>
		startOrder(slice, command.who)
	),
	"ff-next": by("ff-next", (slice, actor) => nextTurn(slice, actor)),
	"ff-end": by("ff-end", (slice) =>
		slice.order === undefined
			? refuse(NO_ORDER)
			: decided(event("ff.order-ended", {}))
	),
} as const satisfies Record<FfCommand["type"], Handler>;

export const decide = (
	slice: FfState,
	actor: string,
	command: FfCommand,
	dice: Dice
): Decision => HANDLERS[command.type](slice, actor, command, dice);
