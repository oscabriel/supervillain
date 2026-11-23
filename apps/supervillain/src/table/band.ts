import { listIf, when, listIfDefined } from "@supervillain/domain";

import type { Combatant, CombatView } from "./view.ts";

export type Tone =
	| "text"
	| "dim"
	| "heroes"
	| "director"
	| "acting"
	| "healthy"
	| "winded"
	| "dying"
	| "dead"
	| "temp";

export interface Segment {
	readonly text: string;
	readonly tone: Tone;
	readonly mine?: boolean;
	readonly who?: string;
}

export type Line = ReadonlyArray<Segment>;

export interface BandLayout {
	readonly title: string;
	readonly lines: ReadonlyArray<Line>;
	readonly more: number;
	readonly keepLines: number;
	readonly livingLines: number;
}

export interface BandOptions {
	readonly heroesWhole?: boolean;
}

const METER = 6;

const GAP = 3;

const MIN_COLUMN = 30;

const NAME_MAX = 20;

const NAME_MIN = 4;

const SEPARATOR: Segment = { text: " · ", tone: "dim" };

interface Cell {
	readonly head: Line;
	readonly details: Line;
	readonly indent: number;
}

const widthOf = (line: Line) =>
	line.reduce((n, s) => n + Bun.stringWidth(s.text), 0);

const textWidth = (text: string) => Bun.stringWidth(text);

const take = (text: string, width: number): string => {
	let out = "";

	for (const ch of text) {
		if (textWidth(out + ch) > width) {
			break;
		}

		out += ch;
	}

	return out;
};

const cut = (text: string, width: number) =>
	textWidth(text) <= width ? text : `${take(text, width - 1).trimEnd()}…`;

const truncate = (line: Line, width: number): Line => {
	if (widthOf(line) <= width) {
		return line;
	}

	const out: Array<Segment> = [];
	let left = width - 1;

	for (const s of line) {
		const w = textWidth(s.text);

		if (w > left) {
			out.push({ ...s, text: take(s.text, left) });
			break;
		}

		out.push(s);
		left -= w;
	}

	return [...out, { text: "…", tone: "dim" }];
};

const pad = (line: Line, width: number): Line => {
	const w = widthOf(line);

	return w >= width
		? line
		: [...line, { text: " ".repeat(width - w), tone: "text" }];
};

const PLAYED = /^(?<hero>.+) \((?<player>.+)\)$/u;

const NUMBERED = /^(?<base>.+?)(?<suffix>(?: (?:\d+|[A-Z]))?)$/u;

const shorten = (name: string, max: number): string => {
	if (textWidth(name) <= max) {
		return name;
	}

	const played = PLAYED.exec(name)?.groups;
	const hero = played?.hero;
	const player = played?.player;

	if (hero !== undefined && player !== undefined) {
		const room = max - textWidth(hero) - 3;

		return room >= 2 ? `${hero} (${cut(player, room)})` : cut(hero, max);
	}

	const numbered = NUMBERED.exec(name)?.groups;
	const base = numbered?.base ?? name;
	const suffix = numbered?.suffix ?? "";

	const words = base.split(" ");

	for (let i = 1; i < words.length; i += 1) {
		const rest = `…${words.slice(i).join(" ")}${suffix}`;

		if (textWidth(rest) <= max) {
			return rest;
		}
	}

	const left = max - textWidth(suffix);

	return suffix !== "" && left >= 2
		? `${cut(words.at(-1) ?? "", left)}${suffix}`
		: cut(name, max);
};

const label = (c: Combatant, max: number): string => {
	const count = c.count === undefined ? "" : ` x${c.count}`;

	return `${shorten(c.name, Math.max(1, max - count.length))}${count}`;
};

const numbers = (c: Combatant) => `${c.stamina}/${c.max}`;

const nonEmpty = (text: string | undefined) => (text === "" ? undefined : text);

const positive = (n: number | undefined) => (n === 0 ? undefined : n);

const healthText = (c: Combatant) =>
	c.health === "dying" && c.deadAt !== undefined
		? `dying (dead at ${c.deadAt})`
		: c.health;

const filled = (c: Combatant): number => {
	if (c.stamina <= 0 || c.max <= 0) {
		return 0;
	}

	return Math.min(METER, Math.max(1, Math.round((c.stamina / c.max) * METER)));
};

const marker = (c: Combatant): Segment => {
	if (c.acting) {
		return { text: "▶ ", tone: "acting" };
	}

	return c.acted ? { text: "✓ ", tone: "dim" } : { text: "· ", tone: "dim" };
};

const MARK = 3;

const cellOf = (
	c: Combatant,
	combat: boolean,
	nameWidth: number,
	numberWidth: number,
	marks = false,
	meter?: string
): Cell => {
	const health: Tone = c.health ?? "healthy";
	const name = label(c, nameWidth);
	const n = filled(c);
	const said = healthText(c);

	const head: Array<Segment> = [
		...listIf(combat, () => [marker(c)]),
		...listIf(marks, () => [
			{
				text: (c.mark ?? "").padEnd(MARK),
				tone: c.health === "dead" ? ("dead" as const) : c.side,
			},
		]),
		{
			text: name,
			tone: c.health === "dead" ? "dead" : c.side,
			...when(c.mine, () => ({ mine: true })),
		},
		{
			text: " ".repeat(Math.max(0, nameWidth - textWidth(name)) + 1),
			tone: "text",
		},
		...listIfDefined(meter, (value) => [
			{ text: `${value} `, tone: "dim" as const },
		]),
		{ text: `▐${"█".repeat(n)}${"░".repeat(METER - n)}▌`, tone: health },
		{ text: ` ${numbers(c).padStart(numberWidth)}`, tone: "text" },
		...listIf(c.temp > 0, () => [
			{ text: ` +${c.temp}`, tone: "temp" as const },
		]),
		...listIfDefined(said, (text) => [SEPARATOR, { text, tone: health }]),
	];

	const conditions = c.conditions.map((text) => ({
		text,
		tone: "text" as const,
	}));

	const doing = c.acting
		? [...actionsSegment(c), ...conditions]
		: [...conditions, ...actionsSegment(c)];

	const details: Array<Segment> = [
		...doing,
		...listIfDefined(nonEmpty(c.resource), (text) => [{ text, tone: c.side }]),
		...listIfDefined(c.recoveries, (r) => [
			{ text: `recoveries ${r.left}/${r.max}`, tone: "text" as const },
		]),
		...listIfDefined(positive(c.surges), (count) => [
			{
				text: `${count} surge${count === 1 ? "" : "s"}`,
				tone: "text" as const,
			},
		]),
	];

	const own = (line: ReadonlyArray<Segment>) =>
		line.map((seg) => ({ ...seg, who: c.id }));

	return {
		head: own(head),
		details: own(details),
		indent:
			(combat ? 2 : 0) +
			(marks ? MARK : 0) +
			nameWidth +
			1 +
			(meter === undefined ? 0 : textWidth(meter) + 1),
	};
};

const pips = (c: Combatant): ReadonlyArray<Segment> => {
	const a = c.actions;

	if (a === undefined) {
		return [];
	}

	if (!c.acting) {
		return a.reaction ? [{ text: "↺", tone: "dim" }] : [];
	}

	const left = Math.max(0, Math.min(a.left, a.max));
	const shown = `${"◆".repeat(left)}${"◇".repeat(a.max - left)}${a.reaction ? " ↺" : ""}`;

	return [{ text: shown, tone: "acting" }];
};

const actionsSegment = (c: Combatant): ReadonlyArray<Segment> => [
	...pips(c),
	...listIfDefined(c.penalty, (value) => [
		{ text: value, tone: "text" as const },
	]),
	...listIfDefined(c.turnActions, (value) => [
		{ text: value, tone: "dim" as const },
	]),
];

const flat = (cell: Cell): Line => [
	...cell.head,
	...cell.details.flatMap((d) => [SEPARATOR, d]),
];

const fit = (cell: Cell, width: number): Line => {
	const whole = flat(cell);

	if (widthOf(whole) <= width) {
		return whole;
	}

	const line: Array<Segment> = [...cell.head];

	for (const d of cell.details) {
		if (widthOf(line) + widthOf([SEPARATOR, d]) + 2 > width) {
			break;
		}

		line.push(SEPARATOR, d);
	}

	return truncate([...line, { text: " …", tone: "dim" }], width);
};

const wrap = (cell: Cell, width: number): ReadonlyArray<Line> => {
	const lines: Array<Array<Segment>> = [[...cell.head]];

	for (const d of cell.details) {
		const current = lines.at(-1) ?? [];

		if (widthOf(current) + widthOf([SEPARATOR, d]) <= width) {
			current.push(SEPARATOR, d);
		} else {
			lines.push([{ text: " ".repeat(cell.indent), tone: "text" }, d]);
		}
	}

	return lines.map((l) => truncate(l, width));
};

interface Packed {
	readonly line: Line;
	readonly whole: () => ReadonlyArray<Line>;
}

interface Placed {
	readonly combatant: Combatant;
	readonly cell: Cell;
}

const pack = (
	entries: ReadonlyArray<Packed>,
	column: number
): ReadonlyArray<Line> => {
	const half = (entry: Packed | undefined): entry is Packed =>
		column >= MIN_COLUMN &&
		entry !== undefined &&
		widthOf(entry.line) <= column;

	const rows: Array<Line> = [];

	for (let i = 0; i < entries.length; i += 1) {
		const here = entries[i];
		const next = entries[i + 1];

		if (half(here) && half(next)) {
			rows.push([...pad(here.line, column + GAP), ...next.line]);
			i += 1;
		} else if (here !== undefined) {
			rows.push(...here.whole());
		}
	}

	return rows;
};

const sideBySide =
	(column: number, width: number) =>
	({ combatant, cell }: Placed): Packed => ({
		line: combatant.side === "director" ? fit(cell, column) : flat(cell),
		whole: () => wrap(cell, width),
	});

const mixedLines = (
	shown: ReadonlyArray<Combatant>,
	active: boolean,
	width: number,
	column: number,
	meter?: string
): ReadonlyArray<Line> => {
	const halves = column >= MIN_COLUMN;

	const cells = cellsOf(
		shown,
		active,
		(c) => (halves && c.side === "director" ? column : width),
		meter
	);

	return pack(cells.map(sideBySide(column, width)), column);
};

const rank = (c: Combatant) => {
	if (c.acting) {
		return 0;
	}

	if (c.mine) {
		return 1;
	}

	return c.health === "dead" ? 3 : 2;
};

const keep = (
	placed: ReadonlyArray<Placed>,
	room: number
): ReadonlyArray<Placed> =>
	[...placed.entries()]
		.toSorted(
			([a, pa], [b, pb]) => rank(pa.combatant) - rank(pb.combatant) || a - b
		)
		.slice(0, room)
		.toSorted(([a], [b]) => a - b)
		.map(([, p]) => p);

const OWN_NAME = /^(?<own>.+) \(.+\)$/u;

const ownName = (name: string) => OWN_NAME.exec(name)?.groups?.own ?? name;

const turnOf = (view: CombatView) => {
	const acting = view.combatants.find((c) => c.acting);

	if (acting !== undefined) {
		return ` · ${ownName(acting.name)}'s turn`;
	}

	return view.next === undefined ? "" : ` · ${view.next} next`;
};

const titleOf = (view: CombatView): string => {
	if (view.title !== undefined) {
		return view.title;
	}

	const victories =
		view.victories === undefined ? "" : ` · victories ${view.victories}`;

	if (!view.active) {
		return ` party · hero tokens ${view.heroTokens}${victories} `;
	}

	const turn = turnOf(view);

	return ` round ${view.round}${turn} · Malice ${view.malice} · hero tokens ${view.heroTokens}${victories} `;
};

const cellsOf = (
	shown: ReadonlyArray<Combatant>,
	combat: boolean,
	room: (c: Combatant) => number,
	meter?: string
): ReadonlyArray<Placed> => {
	const numberWidth = Math.max(0, ...shown.map((c) => numbers(c).length));

	const natural = Math.max(
		0,
		...shown.map((c) => textWidth(label(c, NAME_MAX)))
	);

	const marks = shown.some((c) => c.mark !== undefined);

	const fits = shown.map((c) => {
		const bare = cellOf(c, combat, 0, numberWidth, marks, meter);

		return (
			room(c) - (bare.details.length > 0 ? 2 : 0) - (widthOf(bare.head) - 1)
		);
	});

	const nameWidth = Math.max(NAME_MIN, Math.min(natural, ...fits));

	return shown.map((combatant) => ({
		combatant,
		cell: cellOf(combatant, combat, nameWidth, numberWidth, marks, meter),
	}));
};

const compact = (c: Combatant): Combatant => {
	const { recoveries: _recoveries, ...rest } = c;

	return rest;
};

const fallenLine = (fallen: ReadonlyArray<Combatant>, width: number): Line =>
	truncate(
		[
			{ text: "dead: ", tone: "dim" },
			{ text: fallen.map((c) => c.name).join(", "), tone: "dead" },
		],
		width
	);

export const bandLayout = (
	view: CombatView,
	width: number,
	rows: number,
	options: BandOptions = {}
): BandLayout => {
	const title = titleOf(view);

	const all = view.active
		? view.combatants
		: view.combatants.filter((c) => c.side === "heroes");

	const fallen = all.filter((c) => c.health === "dead");
	const shown = all.filter((c) => !fallen.includes(c));
	const short = shown.map(compact);
	const room = Math.max(1, rows);
	const column = Math.floor((width - GAP) / 2);
	const halves = column >= MIN_COLUMN;
	const tail = fallen.length === 0 ? [] : [fallenLine(fallen, width)];
	const essential = short.filter((c) => c.side === "heroes" || c.acting);
	const meter = view.meterLabel;

	const keepLines = mixedLines(
		essential,
		view.active,
		width,
		column,
		meter
	).length;

	const full = cellsOf(shown, view.active, () => width, meter);

	const mixed = cellsOf(
		shown,
		view.active,
		(c) => (halves && c.side === "director" ? column : width),
		meter
	);

	const oneRowEach = pack(
		mixed.map((placed) => ({
			...sideBySide(column, width)(placed),
			whole: () => [fit(placed.cell, width)],
		})),
		column
	);

	const livingLines = oneRowEach.length;

	const heroesWhole = options.heroesWhole === true;

	const attempts: ReadonlyArray<() => ReadonlyArray<Line>> = [
		() =>
			pack(
				full.map(({ cell }) => ({
					line: flat(cell),
					whole: () => wrap(cell, width),
				})),
				column
			),
		() => mixedLines(shown, view.active, width, column, meter),
		() => mixedLines(short, view.active, width, column, meter),
		...listIf(!heroesWhole, () => [
			() =>
				pack(
					full.map(({ cell }) => ({
						line: flat(cell),
						whole: () => [fit(cell, width)],
					})),
					column
				),
			() => oneRowEach,
		]),
	];

	for (const attempt of attempts) {
		const lines = [...attempt(), ...tail];

		if (lines.length <= room) {
			return { title, lines, more: 0, keepLines, livingLines };
		}
	}

	if (!heroesWhole && livingLines <= room) {
		return {
			title,
			lines: oneRowEach,
			more: fallen.length,
			keepLines,
			livingLines,
		};
	}

	if (heroesWhole) {
		const creatures = short.filter((c) => c.side === "director");

		const order = creatures.toSorted(
			(a, b) => Number(b.acting) - Number(a.acting)
		);

		for (let k = creatures.length; k >= 0; k -= 1) {
			const kept = new Set(order.slice(0, k));

			const lines = mixedLines(
				short.filter((c) => c.side === "heroes" || kept.has(c)),
				view.active,
				width,
				column,
				meter
			);

			if (lines.length <= room) {
				return {
					title,
					lines,
					more: creatures.length - k + fallen.length,
					keepLines,
					livingLines,
				};
			}
		}
	}

	const fitTo = halves ? column : width;
	const narrow = cellsOf(shown, view.active, () => fitTo, meter);

	const kept = keep(narrow, halves ? room * 2 : room).map(({ cell }) =>
		fit(cell, fitTo)
	);

	const lines = pack(
		kept.map((line) => ({ line, whole: () => [line] })),
		column
	);

	if (lines.length < room && tail.length > 0) {
		return {
			title,
			lines: [...lines, ...tail],
			more: shown.length - kept.length,
			keepLines,
			livingLines,
		};
	}

	return {
		title,
		lines,
		more: shown.length - kept.length + fallen.length,
		keepLines,
		livingLines,
	};
};

export const whoAt = (
	line: Line | undefined,
	col: number
): string | undefined => {
	if (line === undefined || col < 0) {
		return undefined;
	}

	let at = 0;
	let before: string | undefined;

	for (const s of line) {
		const end = at + textWidth(s.text);

		if (col < end) {
			if (s.who !== undefined) {
				return s.who;
			}

			if (before !== undefined) {
				return before;
			}

			return line.slice(line.indexOf(s)).find((n) => n.who !== undefined)?.who;
		}

		if (s.who !== undefined) {
			before = s.who;
		}

		at = end;
	}

	return undefined;
};
