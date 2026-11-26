import { RULESET_NAMES } from "@supervillain/domain";

import { DINGS_ATLAS } from "../../table/atlas/dings.ts";
import { TEXT_ATLAS } from "../../table/atlas/text.ts";
import { color } from "../../table/theme.ts";
import { HANDLE_RULE } from "../protocol.ts";
import { commandsOf, createForm, KEYLESS_CREATE } from "./create.ts";
import type { CreateForm } from "./create.ts";
import { TABS } from "./keys.ts";
import type { LobbyTab } from "./keys.ts";

export interface LobbyTable {
	readonly handle: string;
	readonly table: string;
	readonly seated: number;
}

export const tableAddress = (table: LobbyTable): string =>
	`${table.handle}/${table.table}`;

export interface SandboxNote {
	readonly open: boolean;
	readonly cols: number;
	readonly rows: number;
	readonly idleMinutes: number;
	readonly maxMinutes: number;
}

export interface LobbyScreen {
	readonly tab?: LobbyTab;
	readonly editing?: boolean;
	readonly create?: CreateForm;
	readonly sandbox?: SandboxNote;
	readonly tables: ReadonlyArray<LobbyTable>;
	readonly picked: number;
	readonly typed: string;
	readonly said?: string | undefined;
	readonly you: {
		readonly key:
			| { readonly fingerprint: string; readonly algorithm: string }
			| undefined;
		readonly term: string;
	};
}

interface Seg {
	readonly text: string;
	readonly fg?: string;
	readonly bg?: string;
	readonly bold?: boolean;
}

type Row = ReadonlyArray<Seg>;

interface BodyCursor {
	readonly row: number;
	readonly col: number;
}

interface BodyView {
	readonly rows: Array<Row>;
	readonly cursor?: BodyCursor | undefined;
}

interface InputRow {
	readonly row: Row;
	readonly cursorCol: number;
}

interface TabItem {
	readonly tab: LobbyTab;
	readonly segs: Array<Seg>;
	readonly w: number;
}

interface TabSpan {
	readonly start: number;
	readonly end: number;
	readonly on: boolean;
}

const RULE = "#464c5a";

const SHADOW = "#2a2d33";

const MIN_TABLE_COLS = 72;

const MIN_TABLE_ROWS = 20;

const MAX_STAGE_WIDTH = 88;

const WIDE_SPLIT = 74;

const BODY_ROWS = 10;

const width = (s: string) => Bun.stringWidth(s);

const rowWidth = (r: Row) => r.reduce((n, s) => n + width(s.text), 0);

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

const padRow = (r: Row, n: number): Row => {
	const extra = Math.max(0, n - rowWidth(r));

	return extra === 0 ? r : [...r, { text: " ".repeat(extra) }];
};

const centred = (r: Row, n: number): Row => {
	const left = Math.max(0, Math.floor((n - rowWidth(r)) / 2));

	return left === 0 ? r : [{ text: " ".repeat(left) }, ...r];
};

const codePoints = (s: string): Array<string> => Array.from(s, (ch) => ch);

const cut = (s: string, n: number) =>
	width(s) <= n
		? s
		: `${codePoints(s)
				.slice(0, Math.max(0, n - 1))
				.join("")}…`;

const fitRow = (r: Row, max: number): Row => {
	if (rowWidth(r) <= max) {
		return r;
	}

	const out: Array<Seg> = [];
	let left = max;

	for (const seg of r) {
		if (left <= 0) {
			break;
		}

		const segW = width(seg.text);

		if (segW <= left) {
			out.push(seg);
			left -= segW;
		} else {
			out.push({ ...seg, text: cut(seg.text, left) });
			left = 0;
		}
	}

	return out;
};

type Pixels = ReadonlyArray<ReadonlyArray<string | undefined>>;

const bitOf = (byte: number, x: number): boolean =>
	Math.floor(byte / 2 ** (7 - x)) % 2 === 1;

const bits = (hex: string | undefined): Array<Array<boolean>> =>
	Array.from({ length: 12 }, (_row, y) => {
		const pair = hex?.slice(y * 2, y * 2 + 2) ?? "";
		const byte = Number.parseInt(pair === "" ? "00" : pair, 16);

		return Array.from({ length: 8 }, (_bit, x) => bitOf(byte, x));
	});

const pixelAt = (grid: Pixels, y: number, x: number): string | undefined =>
	grid[y]?.[x];

const paint = (
	grid: ReadonlyArray<Array<string | undefined>>,
	y: number,
	x: number,
	fg: string
) => {
	const row = grid[y];

	if (row !== undefined) {
		row[x] = fg;
	}
};

const wordPixels = (word: string, gap: number, fg: string): Pixels => {
	const letters = Array.from(word, (ch) =>
		bits(TEXT_ATLAS[ch])
			.slice(2, 10)
			.map((r) => r.slice(1, 7))
	);

	const w = letters.length * 6 + (letters.length - 1) * gap;

	const grid = Array.from({ length: 9 }, () =>
		Array.from({ length: w + 1 }, (): string | undefined => undefined)
	);

	for (const [i, rows] of letters.entries()) {
		for (const [y, r] of rows.entries()) {
			for (const [x, on] of r.entries()) {
				if (on) {
					paint(grid, y, i * (6 + gap) + x, fg);
				}
			}
		}
	}

	for (let y = 7; y >= 0; y -= 1) {
		for (let x = w - 1; x >= 0; x -= 1) {
			if (
				pixelAt(grid, y, x) === fg &&
				pixelAt(grid, y + 1, x + 1) === undefined
			) {
				paint(grid, y + 1, x + 1, SHADOW);
			}
		}
	}

	return grid;
};

const figurePixels = (ch: string, fg: string): Pixels =>
	bits(DINGS_ATLAS[ch]).map((r) => r.map((on) => (on ? fg : undefined)));

const halfBlock = (
	top: string | undefined,
	bottom: string | undefined
): Seg => {
	if (top === undefined) {
		return bottom === undefined ? { text: " " } : { text: "▄", fg: bottom };
	}

	if (bottom === undefined) {
		return { text: "▀", fg: top };
	}

	return top === bottom
		? { text: "█", fg: top }
		: { text: "▀", fg: top, bg: bottom };
};

const halfBlocks = (p: Pixels): Array<Row> => {
	const rows: Array<Row> = [];

	for (let y = 0; y < p.length; y += 2) {
		const under = p[y + 1] ?? [];

		rows.push((p[y] ?? []).map((top, x) => halfBlock(top, under[x])));
	}

	return rows;
};

const QUADRANTS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";

const quadrant = (px: ReadonlyArray<string | undefined>): Seg => {
	const lit = px.map((c) => c !== undefined && c !== SHADOW);
	const index = lit.reduce((n, on, i) => n + (on ? 2 ** i : 0), 0);
	const text = QUADRANTS[index] ?? " ";
	const fg = px.find((c) => c !== undefined && c !== SHADOW);

	return fg === undefined ? { text } : { text, fg };
};

const quadrants = (p: Pixels): Array<Row> => {
	const rows: Array<Row> = [];

	for (let y = 0; y < p.length; y += 2) {
		const top = p[y] ?? [];
		const under = p[y + 1] ?? [];
		const row: Array<Seg> = [];

		for (let x = 0; x < top.length; x += 2) {
			row.push(quadrant([top[x], top[x + 1], under[x], under[x + 1]]));
		}

		rows.push(row);
	}

	return rows;
};

const beside = (blocks: ReadonlyArray<Array<Row>>, gap: number): Array<Row> => {
	const h = Math.max(...blocks.map((b) => b.length));
	const widths = blocks.map((b) => Math.max(...b.map(rowWidth)));

	return Array.from({ length: h }, (_row, y) =>
		blocks.flatMap((b, i) => {
			const padded = padRow(b[y - (h - b.length)] ?? [], widths[i] ?? 0);

			return i === 0 ? padded : [{ text: " ".repeat(gap) }, ...padded];
		})
	);
};

const banner = (cols: number): Array<Row> => {
	const tight = wordPixels("SUPERVILLAIN", 1, color.bright);

	if (cols >= 112) {
		return beside(
			[
				halfBlocks(figurePixels("&", color.heroes)),
				halfBlocks(tight),
				halfBlocks(figurePixels('"', color.director)),
			],
			3
		);
	}

	if (cols >= 88) {
		return halfBlocks(tight);
	}

	if (cols >= 50) {
		return quadrants(wordPixels("SUPERVILLAIN", 2, color.bright));
	}

	return [];
};

const heading = (title: string, w: number, fg: string = color.dim): Row => [
	{ text: cut(title, w), fg, bold: fg === color.bright },
];

const field = (name: string, value: Row, labelWidth = 10): Row => [
	{ text: pad(name, labelWidth), fg: color.dim },
	...value,
];

const pill = (text: string, bg: string, fg: string): Seg => ({
	text: ` ${text} `,
	fg,
	bg,
	bold: true,
});

const tabOf = (screen: LobbyScreen): LobbyTab => screen.tab ?? "tables";

const editingOf = (screen: LobbyScreen): boolean => screen.editing === true;

const formOf = (screen: LobbyScreen): CreateForm =>
	screen.create ?? createForm(screen.you.key === undefined, undefined);

const words = (text: string, fg: string, w: number): Array<Row> => {
	const lines: Array<Row> = [];
	let line = "";

	for (const word of text.split(" ")) {
		if (line !== "" && width(line) + 1 + width(word) > w) {
			lines.push([{ text: line, fg }]);
			line = word;
		} else {
			line = line === "" ? word : `${line} ${word}`;
		}
	}

	if (line !== "") {
		lines.push([{ text: line, fg }]);
	}

	return lines;
};

const columnGap = (w: number): number => {
	if (w >= 84) {
		return 6;
	}

	return w >= 78 ? 4 : 3;
};

const twoColumns = (
	left: ReadonlyArray<Row>,
	right: ReadonlyArray<Row>,
	leftW: number,
	gap: number
): Array<Row> => {
	const height = Math.max(left.length, right.length);
	const out: Array<Row> = [];

	for (let i = 0; i < height; i += 1) {
		const leftRow = left[i] ?? [];
		const rightRow = right[i] ?? [];

		out.push([
			...padRow(fitRow(leftRow, leftW), leftW),
			{ text: " ".repeat(gap) },
			...rightRow,
		]);
	}

	return out;
};

const TAB_LONG: Readonly<Record<LobbyTab, string>> = {
	tables: "Tables",
	try: "Try a Table",
	create: "Create a Table",
	session: "Session",
};

const TAB_SHORT: Readonly<Record<LobbyTab, string>> = {
	tables: "Tables",
	try: "Try",
	create: "Create",
	session: "Session",
};

const TAB_TINY: Readonly<Record<LobbyTab, string>> = {
	tables: "Tab",
	try: "Try",
	create: "New",
	session: "Info",
};

const tabNamesFor = (w: number): Readonly<Record<LobbyTab, string>> => {
	if (w >= 68) {
		return TAB_LONG;
	}

	return w >= 44 ? TAB_SHORT : TAB_TINY;
};

const navGap = (w: number): number => {
	if (w >= 76) {
		return 4;
	}

	return w >= 56 ? 2 : 1;
};

const headerRow = (left: Row, warn: Row, w: number): Row => {
	if (left.length === 0) {
		return fitRow(warn, w);
	}

	if (warn.length === 0) {
		return fitRow(left, w);
	}

	const between = Math.max(1, w - rowWidth(left) - rowWidth(warn));

	return fitRow([...left, { text: " ".repeat(between) }, ...warn], w);
};

const tabKeyColor = (on: boolean, editing: boolean): string => {
	if (on) {
		return color.brand;
	}

	return editing ? color.dim : color.bright;
};

const navBar = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number,
	showArt: boolean
): Array<Row> => {
	const active = tabOf(screen);
	const editing = editingOf(screen);
	const names = tabNamesFor(w);
	const openCount = screen.tables.length;
	const tight = cols < MIN_TABLE_COLS || rows < MIN_TABLE_ROWS;
	const gapSize = navGap(w);

	const header: Array<Row> = [];

	if (!showArt || tight) {
		const left: Row = showArt
			? []
			: [
					{ text: "◆ ", fg: color.brand },
					{ text: "supervillain", fg: color.brand, bold: true },
					{ text: " · lobby", fg: color.dim },
				];

		const warn: Row = tight
			? [{ text: `! ${cols}×${rows} (min 72×20)`, fg: color.notice }]
			: [];

		header.push(headerRow(left, warn, w));
	}

	const items: Array<TabItem> = TABS.map((tab, i) => {
		const on = tab === active;
		const keyFg = tabKeyColor(on, editing);
		const labelFg = on ? color.bright : color.dim;

		const segs: Array<Seg> = [
			{ text: ` ${i + 1} `, fg: keyFg, bold: !editing || on },
			{ text: names[tab], fg: labelFg, bold: on },
		];

		if (tab === "tables" && openCount > 0) {
			segs.push({
				text: ` · ${openCount}`,
				fg: color.healthy,
				bold: on,
			});
		}

		segs.push({ text: " " });

		return { tab, segs, w: rowWidth(segs) };
	});

	const totalItemsW = items.reduce((sum, item) => sum + item.w, 0);
	const leftGaps = Math.max(0, items.length - 2) * gapSize;
	const trailingGap = Math.max(gapSize, w - totalItemsW - leftGaps);

	const labelRow: Array<Seg> = [];
	const spans: Array<TabSpan> = [];
	let col = 0;

	for (const [i, item] of items.entries()) {
		if (i > 0) {
			const gap = i === items.length - 1 ? trailingGap : gapSize;
			labelRow.push({ text: " ".repeat(gap) });
			col += gap;
		}

		const start = col;
		labelRow.push(...item.segs);
		col += item.w;
		spans.push({ start, end: col, on: item.tab === active });
	}

	const activeSpan = spans.find((s) => s.on);
	const ruleRow: Array<Seg> = [];

	if (activeSpan === undefined) {
		ruleRow.push({ text: "─".repeat(w), fg: RULE });
	} else {
		const leftLen = Math.min(w, activeSpan.start);
		const markLen = Math.max(0, Math.min(w, activeSpan.end) - leftLen);
		const rightLen = Math.max(0, w - leftLen - markLen);

		if (leftLen > 0) {
			ruleRow.push({ text: "─".repeat(leftLen), fg: RULE });
		}

		if (markLen > 0) {
			ruleRow.push({ text: "━".repeat(markLen), fg: color.brand });
		}

		if (rightLen > 0) {
			ruleRow.push({ text: "─".repeat(rightLen), fg: RULE });
		}
	}

	return [...header, fitRow(labelRow, w), ruleRow];
};

const tableInputRow = (
	typed: string,
	editing: boolean,
	w: number
): InputRow => {
	const shown = cut(typed, Math.max(1, w - 2));

	if (editing) {
		const row: Row =
			typed === ""
				? [
						{ text: "> ", fg: color.brand, bold: true },
						{ text: cut("handle/table", Math.max(1, w - 2)), fg: color.dim },
					]
				: [
						{ text: "> ", fg: color.brand, bold: true },
						{ text: shown, fg: color.bright, bold: true },
					];

		return { row, cursorCol: 2 + width(shown) };
	}

	return {
		row: [
			pill("join by name", color.brand, color.cursorFg),
			{ text: "  enter", fg: color.dim },
		],
		cursorCol: 0,
	};
};

const emptyTablesLeft = (screen: LobbyScreen, w: number): BodyView => {
	const guest = screen.you.key === undefined;
	const editing = editingOf(screen);
	const input = tableInputRow(screen.typed, editing, w);

	if (editing) {
		const rows: Array<Row> = [
			heading("join by table name", w, color.bright),
			[],
			...words(
				"Enter the address your GM gave you, like ana/first-fight.",
				color.dim,
				w
			),
			[],
		];

		const inputRowIndex = rows.length;
		rows.push(input.row);

		return {
			rows,
			cursor: { row: inputRowIndex, col: input.cursorCol },
		};
	}

	const status: Row = guest
		? [
				{ text: "○ ", fg: color.gm },
				{ text: cut("guest session · no saved tables", w - 2), fg: color.text },
			]
		: [
				{ text: "○ ", fg: color.dim },
				{ text: cut("no open tables yet", w - 2), fg: color.text },
			];

	const note = guest
		? "Add an SSH key so tables remember your seat. You can still join any table by name."
		: "Tables you've played at appear here whenever their GM is live.";

	return {
		rows: [
			heading("join a table", w),
			status,
			[],
			...words(note, color.dim, w),
			[],
			input.row,
		],
	};
};

const gettingStartedRight = (screen: LobbyScreen, w: number): Array<Row> => {
	const editing = editingOf(screen);

	if (editing) {
		const target = screen.typed === "" ? "<handle>/<table>" : screen.typed;

		return [
			heading("direct command", w),
			[{ text: cut(`ssh ${target}@…`, w), fg: color.dice }],
			[],
			...words(
				"Short names (just the table) work once a table knows your key.",
				color.dim,
				w
			),
		];
	}

	return [
		heading("getting started", w),
		[
			{ text: "2  ", fg: color.bright, bold: true },
			{ text: "Try a Table", fg: color.bright, bold: true },
		],
		...words(
			"Play a solo Draw Steel encounter right here — nothing saved.",
			color.dim,
			Math.max(8, w - 3)
		).map((r): Row => [{ text: "   " }, ...r]),
		[],
		[
			{ text: "3  ", fg: color.bright, bold: true },
			{ text: "Create a Table", fg: color.bright, bold: true },
		],
		...words(
			"Claim a GM handle and host campaigns from your machine.",
			color.dim,
			Math.max(8, w - 3)
		).map((r): Row => [{ text: "   " }, ...r]),
	];
};

const openTablesLeft = (
	screen: LobbyScreen,
	w: number,
	maxItems: number
): Array<Row> => {
	const { tables, picked } = screen;
	const editing = editingOf(screen);
	const shown = Math.min(tables.length, Math.max(1, maxItems));
	const clampedPick = Math.min(picked, tables.length - 1);

	const start = Math.max(
		0,
		Math.min(clampedPick - Math.floor(shown / 2), tables.length - shown)
	);

	const slice = tables.slice(start, start + shown);
	const rows: Array<Row> = [heading("open tables", w)];

	for (const [offset, t] of slice.entries()) {
		const i = start + offset;
		const on = i === picked && !editing;
		const seated = `${t.seated > 0 ? "●" : "○"} ${t.seated}`;
		const nameW = Math.max(4, w - 4 - width(seated));
		const room = pad(cut(tableAddress(t), nameW), nameW);

		if (on) {
			rows.push([
				{
					text: ` ${room}  ${seated} `,
					fg: color.cursorFg,
					bg: color.brand,
					bold: true,
				},
			]);
		} else {
			rows.push([
				{ text: ` ${room}  `, fg: color.text },
				{ text: `${seated} `, fg: t.seated > 0 ? color.healthy : color.dim },
			]);
		}
	}

	if (tables.length > shown) {
		const above = start;
		const below = tables.length - (start + shown);
		const parts: Array<string> = [];

		if (above > 0) {
			parts.push(`↑${above}`);
		}

		if (below > 0) {
			parts.push(`↓${below}`);
		}

		rows.push([{ text: ` ${parts.join("  ")}`, fg: color.dim }]);
	}

	rows.push([]);
	const joinSelected = picked === tables.length || editing;

	const joinLabel = pad(
		cut("+ join another table…", Math.max(4, w - 2)),
		Math.max(4, w - 2)
	);

	if (joinSelected && !editing) {
		rows.push([
			{
				text: ` ${joinLabel} `,
				fg: color.cursorFg,
				bg: color.brand,
				bold: true,
			},
		]);
	} else if (editing) {
		rows.push([
			{
				text: ` ${joinLabel} `,
				fg: color.bright,
				bg: color.mineBg,
				bold: true,
			},
		]);
	} else {
		rows.push([{ text: ` ${joinLabel} `, fg: color.dim }]);
	}

	return rows;
};

const openTablesRight = (screen: LobbyScreen, w: number): BodyView => {
	const editing = editingOf(screen);
	const current = screen.tables[screen.picked];

	if (editing) {
		const title = screen.typed === "" ? "join another table" : screen.typed;
		const input = tableInputRow(screen.typed, true, w);

		const rows: Array<Row> = [
			heading(title, w, color.bright),
			[
				{ text: "◈ ", fg: color.brand },
				{ text: cut("joining by table name", w - 2), fg: color.text },
			],
			[],
		];

		const inputRowIndex = rows.length;

		rows.push(
			input.row,
			[],
			field("direct", [
				{
					text: cut(
						`ssh ${screen.typed === "" ? "<handle>/<table>" : screen.typed}@…`,
						w - 10
					),
					fg: color.dice,
				},
			])
		);

		return {
			rows,
			cursor: { row: inputRowIndex, col: input.cursorCol },
		};
	}

	if (current !== undefined) {
		const live: Row =
			current.seated > 0
				? [
						{ text: `● ${current.seated} seated`, fg: color.healthy },
						{ text: " · open now", fg: color.dim },
					]
				: [
						{ text: "○ empty", fg: color.dim },
						{ text: " · open now", fg: color.dim },
					];

		return {
			rows: [
				heading(tableAddress(current), w, color.bright),
				live,
				[],
				[
					pill("sit down", color.brand, color.cursorFg),
					{ text: "  enter", fg: color.dim },
				],
				[],
				field("direct", [
					{
						text: cut(`ssh ${tableAddress(current)}@…`, w - 10),
						fg: color.dice,
					},
				]),
			],
		};
	}

	return {
		rows: [
			heading("join another table", w, color.bright),
			...words(
				"Type any table's <handle>/<table> address to sit down at a table not listed here.",
				color.dim,
				w
			),
			[],
			[
				pill("type a name", color.brand, color.cursorFg),
				{ text: "  enter", fg: color.dim },
			],
		],
	};
};

const tablesBody = (screen: LobbyScreen, w: number, rows: number): BodyView => {
	const n = screen.tables.length;
	const editing = editingOf(screen);
	const maxList = Math.max(4, Math.min(n, Math.max(BODY_ROWS - 3, rows - 16)));

	if (w < WIDE_SPLIT) {
		if (n === 0) {
			return emptyTablesLeft(screen, w);
		}

		if (editing) {
			return openTablesRight(screen, w);
		}

		return { rows: openTablesLeft(screen, w, maxList) };
	}

	const gap = columnGap(w);
	const leftW = Math.floor((w - gap) * 0.45);
	const rightW = w - gap - leftW;

	if (n === 0) {
		const left = emptyTablesLeft(screen, leftW);
		const right = gettingStartedRight(screen, rightW);

		return {
			rows: twoColumns(left.rows, right, leftW, gap),
			cursor: left.cursor,
		};
	}

	const left = openTablesLeft(screen, leftW, maxList);
	const right = openTablesRight(screen, rightW);

	return {
		rows: twoColumns(left, right.rows, leftW, gap),
		cursor:
			right.cursor === undefined
				? undefined
				: { row: right.cursor.row, col: leftW + gap + right.cursor.col },
	};
};

const tryBody = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number
): BodyView => {
	const { sandbox } = screen;
	const open = sandbox?.open === true;

	const action: Row = open
		? [
				pill("start sandbox", color.brand, color.cursorFg),
				{ text: "  enter", fg: color.dim },
			]
		: [
				{ text: "○ ", fg: color.dim },
				{
					text: cut("this relay offers no sandbox tables", w - 2),
					fg: color.dim,
				},
			];

	const pitch = (colW: number): Array<Row> => [
		[
			{ text: "◆ ", fg: color.brand },
			{
				text: cut("Solo Draw Steel sandbox", colW - 2),
				fg: color.bright,
				bold: true,
			},
		],
		[],
		...words(
			"Play the sample encounter as GM: Brann and Ilsa on the Ford Road against the bandits. Roll, move tokens, and run the fight.",
			color.text,
			colW
		),
		[],
		...words(
			"Nothing is saved: the table lives in memory and vanishes when you leave.",
			color.dim,
			colW
		),
		[],
		action,
	];

	const details = (colW: number): Array<Row> => {
		if (sandbox === undefined) {
			return [];
		}

		const fits = cols >= sandbox.cols && rows >= sandbox.rows;

		const sizeMark: Array<Seg> = fits
			? [{ text: ` ✓ ${cols}×${rows}`, fg: color.healthy }]
			: [{ text: ` ! ${cols}×${rows}`, fg: color.notice }];

		return [
			heading("details", colW),
			field("ruleset", [{ text: "draw-steel", fg: color.text }]),
			fitRow(
				field("window", [
					{ text: `${sandbox.cols}×${sandbox.rows}+`, fg: color.text },
					...sizeMark,
				]),
				colW
			),
			field("closes", [
				{
					text: cut(
						`${sandbox.idleMinutes} min idle · ${sandbox.maxMinutes} min max`,
						colW - 10
					),
					fg: color.text,
				},
			]),
			field("help", [{ text: "/help inside the table", fg: color.dim }]),
		];
	};

	if (w < WIDE_SPLIT || sandbox === undefined) {
		const left = pitch(w);
		const extra = sandbox === undefined ? [] : [[], ...details(w)];

		return { rows: [...left, ...extra] };
	}

	const gap = columnGap(w);
	const leftW = Math.floor((w - gap) * 0.56);
	const rightW = w - gap - leftW;

	return {
		rows: twoColumns(pitch(leftW), details(rightW), leftW, gap),
	};
};

const stepsRow = (form: CreateForm, w: number): Row => {
	const steps: ReadonlyArray<readonly [CreateForm["step"], string]> = [
		["handle", "handle"],
		["table", "table & rules"],
		["ready", "ready"],
	];

	return fitRow(
		steps.flatMap(([step, label], i): Row => {
			const on = step === form.step;
			const sep: Row = i === 0 ? [] : [{ text: "  /  ", fg: RULE }];

			return [
				...sep,
				{ text: label, fg: on ? color.bright : color.dim, bold: on },
			];
		}),
		w
	);
};

export const shellLines = (command: string, w: number): Array<string> => {
	if (width(command) <= w) {
		return [command];
	}

	const lines: Array<string> = [];
	let line = "";

	for (const word of command.split(" ")) {
		const room = lines.length === 0 ? w - 2 : w - 4;

		if (line !== "" && width(line) + 1 + width(word) > room) {
			lines.push(line);
			line = word;
		} else {
			line = line === "" ? word : `${line} ${word}`;
		}
	}

	lines.push(line);

	return lines.map((text, i) => {
		const lead = i === 0 ? "" : "  ";

		return i === lines.length - 1 ? `${lead}${text}` : `${lead}${text} \\`;
	});
};

const rulesRow = (form: CreateForm, choosing: boolean): Row =>
	choosing
		? RULESET_NAMES.flatMap((name, i): Row => {
				const gap: Row = i === 0 ? [] : [{ text: "  " }];

				return name === form.rules
					? [...gap, { text: `‹ ${name} ›`, fg: color.bright, bold: true }]
					: [...gap, { text: name, fg: color.dim }];
			})
		: [{ text: form.rules, fg: color.text }];

const inlineInputField = (
	label: string,
	value: string,
	placeholder: string,
	editing: boolean,
	w: number
): InputRow => {
	const valueW = Math.max(4, w - 12);
	const shown = cut(value, valueW);

	if (editing) {
		const display: Array<Seg> =
			value === ""
				? [{ text: cut(placeholder, valueW), fg: color.dim }]
				: [{ text: shown, fg: color.bright, bold: true }];

		return {
			row: field(label, [
				{ text: "› ", fg: color.brand, bold: true },
				...display,
			]),
			cursorCol: 12 + width(shown),
		};
	}

	const display: Array<Seg> =
		value === ""
			? [{ text: "…", fg: color.dim }]
			: [
					{ text: shown, fg: color.bright, bold: true },
					{ text: "   e to edit", fg: color.dim },
				];

	return {
		row: fitRow(field(label, display), w),
		cursorCol: 0,
	};
};

const createBody = (screen: LobbyScreen, w: number): BodyView => {
	const form = formOf(screen);
	const editing = editingOf(screen);

	if (form.guest) {
		return {
			rows: [
				[
					{ text: "○ ", fg: color.gm },
					{
						text: cut("Creating a table needs an SSH key", w - 2),
						fg: color.bright,
						bold: true,
					},
				],
				[],
				...words(KEYLESS_CREATE, color.text, w),
				[],
				field("setup", [
					{ text: cut("ssh-keygen -t ed25519", w - 10), fg: color.dice },
				]),
			],
		};
	}

	const head: Array<Row> = [stepsRow(form, w), []];

	if (form.step === "handle") {
		if (form.held !== undefined) {
			return {
				rows: [
					...head,
					[
						{ text: "● ", fg: color.healthy },
						{ text: "You hold ", fg: color.text },
						{ text: cut(form.held, w - 11), fg: color.bright, bold: true },
					],
					...words(
						`Players join with ssh ${form.held}/<table>@…`,
						color.dim,
						w
					),
					[],
					[
						pill("continue", color.brand, color.cursorFg),
						{ text: "  enter", fg: color.dim },
					],
				],
			};
		}

		const input = inlineInputField(
			"handle",
			form.handle,
			"type your handle…",
			editing,
			w
		);

		const lead: Array<Row> = [
			...head,
			...words(
				"Pick your GM handle. Players put it before your table's name, bound to this SSH key.",
				color.text,
				w
			),
			[],
		];

		const inputRowIndex = lead.length;

		const rows: Array<Row> = [
			...lead,
			input.row,
			field("format", [{ text: cut(HANDLE_RULE, w - 10), fg: color.dim }]),
		];

		if (!editing) {
			rows.push(
				[],
				[
					pill("set handle", color.brand, color.cursorFg),
					{ text: "  enter", fg: color.dim },
				]
			);
		}

		return {
			rows,
			cursor: editing
				? { row: inputRowIndex, col: input.cursorCol }
				: undefined,
		};
	}

	if (form.step === "table" || form.ready === undefined) {
		const tableInput = inlineInputField(
			"table",
			form.table,
			"type your table's name…",
			editing,
			w
		);

		const top: Array<Row> = [
			...head,
			field("handle", [{ text: cut(form.handle, w - 10), fg: color.bright }]),
		];

		const inputRowIndex = top.length;

		return {
			rows: [
				...top,
				tableInput.row,
				fitRow(field("rules", rulesRow(form, true)), w),
				[],
				...words(
					"Enter makes a one-time pairing code so your computer's GM key can host under this handle.",
					color.dim,
					w
				),
			],
			cursor: editing
				? { row: inputRowIndex, col: tableInput.cursorCol }
				: undefined,
		};
	}

	const commands = commandsOf(form, form.ready);

	const shell = [commands.install, commands.create].flatMap((command) =>
		shellLines(command, Math.max(12, w - 2)).map((line): Row => [
			{ text: `  ${line}`, fg: color.dice },
		])
	);

	return {
		rows: [
			...head,
			[
				{ text: "● ", fg: color.healthy },
				{
					text: cut("Run these on your computer", w - 2),
					fg: color.bright,
					bold: true,
				},
			],
			[],
			...shell,
			[],
			...words(
				"The code works once for 15 minutes and was copied to your clipboard if your terminal allows OSC 52.",
				color.dim,
				w
			),
			[],
			field("table", [
				{
					text: cut(`${form.handle}/${form.table} · ${form.rules}`, w - 10),
					fg: color.text,
				},
			]),
		],
	};
};

const commandRows = (colW: number): Array<Row> => [
	heading("commands", colW),
	field("direct", [
		{ text: cut("ssh <handle>/<table>@…", colW - 10), fg: color.dice },
	]),
	field("host", [
		{
			text: cut("supervillain host --handle <you> --relay", colW - 10),
			fg: color.director,
		},
	]),
	field("rules", [
		{
			text: cut("draw-steel · set.world · pf2e · freeform", colW - 10),
			fg: color.text,
		},
	]),
];

const sessionBody = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number
): BodyView => {
	const yours = screen.you.key;
	const { held } = formOf(screen);
	const n = screen.tables.length;
	const tight = cols < MIN_TABLE_COLS || rows < MIN_TABLE_ROWS;

	const leftCol = (colW: number): Array<Row> => {
		const out: Array<Row> = [
			heading("session", colW),
			field("terminal", [
				{ text: cut(screen.you.term, colW - 10), fg: color.text },
			]),
			field("window", [
				{
					text: cut(
						tight ? `${cols}×${rows} (min 72×20)` : `${cols}×${rows}`,
						colW - 10
					),
					fg: tight ? color.notice : color.text,
				},
			]),
			field("tables", [
				{
					text: n === 0 ? "0 open" : `${n} open`,
					fg: n > 0 ? color.healthy : color.dim,
				},
			]),
			field("auth", [
				{
					text: yours === undefined ? "guest" : "ssh key",
					fg: yours === undefined ? color.gm : color.heroes,
				},
			]),
		];

		if (yours !== undefined) {
			out.push(
				field("handle", [
					{
						text: cut(held ?? "none claimed", colW - 10),
						fg: held === undefined ? color.dim : color.bright,
					},
				])
			);
		}

		return out;
	};

	const keyRows = (colW: number): Array<Row> => {
		if (yours === undefined) {
			return [
				heading("ssh key", colW),
				field("key", [
					{ text: "none", fg: color.gm },
					{
						text: cut(" · ephemeral seat", Math.max(0, colW - 14)),
						fg: color.dim,
					},
				]),
				field("setup", [
					{ text: cut("ssh-keygen -t ed25519", colW - 10), fg: color.dice },
				]),
			];
		}

		const algo = cut(yours.algorithm, Math.max(4, colW - 10));
		const noteSpace = colW - 10 - width(algo);
		const algoRow: Array<Seg> = [{ text: algo, fg: color.heroes }];

		if (noteSpace >= 13) {
			algoRow.push({ text: " · no account", fg: color.dim });
		}

		return [
			heading("ssh key", colW),
			field("key", algoRow),
			[{ text: cut(yours.fingerprint, colW), fg: color.bright }],
		];
	};

	if (w < WIDE_SPLIT) {
		return {
			rows: [...leftCol(w), [], ...keyRows(w)],
		};
	}

	const gap = columnGap(w);
	const rightW = Math.min(54, Math.max(50, Math.floor((w - gap) * 0.62)));
	const leftW = w - gap - rightW;

	return {
		rows: twoColumns(
			leftCol(leftW),
			[...keyRows(rightW), [], ...commandRows(rightW)],
			leftW,
			gap
		),
	};
};

const hint = (k: string, what: string): Array<Seg> => [
	{ text: k, fg: color.bright, bold: true },
	{ text: ` ${what}`, fg: color.dim },
];

const joinHints = (parts: ReadonlyArray<Array<Seg>>): Row =>
	parts.flatMap((p, i) => (i === 0 ? p : [{ text: "   " }, ...p]));

const tableFooter = (screen: LobbyScreen): ReadonlyArray<Array<Seg>> => {
	if (editingOf(screen)) {
		return [
			hint("enter", "sit down"),
			hint("esc", "cancel"),
			hint("ctrl-c", "quit"),
		];
	}

	if (screen.tables.length === 0) {
		return [
			hint("enter", "join by name"),
			hint("1-4", "tabs"),
			hint("tab", "next"),
			hint("q", "quit"),
		];
	}

	if (screen.picked >= screen.tables.length) {
		return [
			hint("↑/↓", "pick"),
			hint("enter", "join by name"),
			hint("1-4", "tabs"),
			hint("q", "quit"),
		];
	}

	return [
		hint("↑/↓", "pick"),
		hint("enter", "sit down"),
		hint("/", "join by name"),
		hint("1-4", "tabs"),
		hint("q", "quit"),
	];
};

const createFooter = (
	form: CreateForm,
	editing: boolean
): ReadonlyArray<Array<Seg>> => {
	if (form.guest) {
		return [hint("1-4", "tabs"), hint("tab", "next"), hint("q", "quit")];
	}

	if (form.step === "ready") {
		return [
			hint("c", "copy commands"),
			hint("1-4", "tabs"),
			hint("tab", "next"),
			hint("q", "quit"),
		];
	}

	if (form.step === "handle") {
		if (form.held !== undefined) {
			return [
				hint("enter", "continue"),
				hint("1-4", "tabs"),
				hint("tab", "next"),
				hint("q", "quit"),
			];
		}

		return editing
			? [
					hint("enter", "claim handle"),
					hint("esc", "cancel"),
					hint("ctrl-c", "quit"),
				]
			: [
					hint("enter", "set handle"),
					hint("1-4", "tabs"),
					hint("tab", "next"),
					hint("q", "quit"),
				];
	}

	if (editing) {
		return [
			hint("←/→", "rules"),
			hint("enter", "create code"),
			hint("esc", "cancel"),
			hint("ctrl-c", "quit"),
		];
	}

	return form.table === ""
		? [
				hint("enter", "set table"),
				hint("←/→", "rules"),
				hint("1-4", "tabs"),
				hint("q", "quit"),
			]
		: [
				hint("enter", "create code"),
				hint("e", "edit"),
				hint("←/→", "rules"),
				hint("1-4", "tabs"),
				hint("q", "quit"),
			];
};

const footerParts = (screen: LobbyScreen): ReadonlyArray<Array<Seg>> => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return screen.sandbox?.open === true
			? [
					hint("enter", "start sandbox"),
					hint("1-4", "tabs"),
					hint("tab", "next"),
					hint("q", "quit"),
				]
			: [hint("1-4", "tabs"), hint("tab", "next"), hint("q", "quit")];
	}

	if (tab === "create") {
		return createFooter(formOf(screen), editingOf(screen));
	}

	if (tab === "session") {
		return screen.you.key === undefined
			? [hint("1-4", "tabs"), hint("tab", "next"), hint("q", "quit")]
			: [
					hint("c", "copy fingerprint"),
					hint("1-4", "tabs"),
					hint("tab", "next"),
					hint("q", "quit"),
				];
	}

	return tableFooter(screen);
};

const footerRow = (screen: LobbyScreen, w: number): Row => {
	const full = joinHints(footerParts(screen));

	if (rowWidth(full) <= w) {
		return centred(full, w);
	}

	const compact = editingOf(screen)
		? joinHints([
				hint("enter", "ok"),
				hint("esc", "cancel"),
				hint("ctrl-c", "quit"),
			])
		: joinHints([hint("1-4", "tabs"), hint("q", "quit")]);

	return centred(fitRow(compact, w), w);
};

const saidOf = (screen: LobbyScreen): string | undefined =>
	tabOf(screen) === "create" ? formOf(screen).said : screen.said;

const bodyOf = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number
): BodyView => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return tryBody(screen, w, cols, rows);
	}

	if (tab === "create") {
		return createBody(screen, w);
	}

	if (tab === "session") {
		return sessionBody(screen, w, cols, rows);
	}

	return tablesBody(screen, w, rows);
};

const layout = (screen: LobbyScreen, cols: number, rows: number) => {
	const w = Math.max(24, Math.min(cols - 4, MAX_STAGE_WIDTH));
	const art = banner(cols);
	const tight = cols < MIN_TABLE_COLS || rows < MIN_TABLE_ROWS;
	const view = bodyOf(screen, w, cols, rows);

	const minBody = Math.min(BODY_ROWS, Math.max(1, rows - 9));
	const naturalBody = Math.max(view.rows.length, minBody);
	const chromeWithArt = (tight ? 1 : 0) + 2 + 1 + 1 + 1 + 1;

	const showArt =
		art.length > 0 && art.length + 1 + chromeWithArt + naturalBody <= rows;

	const nav = navBar(screen, w, cols, rows, showArt);
	const fixedRows = nav.length + 1 + 1 + 1 + 1;

	const maxBody = Math.max(
		1,
		rows - fixedRows - (showArt ? art.length + 1 : 0)
	);

	const paddedBody: Array<Row> = [...view.rows];

	while (paddedBody.length < Math.min(minBody, maxBody)) {
		paddedBody.push([]);
	}

	const body = paddedBody.slice(0, maxBody);
	const bodyStart = nav.length + 1;
	const said = saidOf(screen);

	const feedback: Row =
		said === undefined
			? []
			: [{ text: `› ${cut(said, w - 2)}`, fg: color.notice }];

	const stage: Array<Row> = [
		...nav,
		[],
		...body,
		feedback,
		[{ text: "─".repeat(w), fg: RULE }],
		footerRow(screen, w),
	];

	const stageLeft = Math.max(0, Math.floor((cols - w) / 2));

	const positionedArt: Array<Row> = showArt
		? [...art.map((r) => centred(r, cols)), []]
		: [];

	const positionedStage: Array<Row> = stage.map((r) =>
		stageLeft === 0 || r.length === 0
			? r
			: [{ text: " ".repeat(stageLeft) }, ...r]
	);

	const combined = [...positionedArt, ...positionedStage];
	const topPad = Math.max(0, Math.floor((rows - combined.length) * 0.4));

	const out: Array<Row> = [
		...Array.from({ length: topPad }, (): Row => []),
		...combined,
	];

	const cursor =
		view.cursor !== undefined && view.cursor.row < body.length
			? {
					row: topPad + positionedArt.length + bodyStart + view.cursor.row + 1,
					col: stageLeft + view.cursor.col,
				}
			: undefined;

	return {
		rows: out,
		cursor,
	};
};

const rgb = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

const ansi = (r: Row): string => {
	let out = "";
	let style = "";
	let shaded = false;

	for (const s of r) {
		if (s.bg === undefined && !shaded && s.text.trim() === "") {
			out += s.text;
			continue;
		}

		const codes: Array<string> = [];

		if (s.bold === true) {
			codes.push("1");
		}

		if (s.fg !== undefined) {
			codes.push(`38;2;${rgb(s.fg)}`);
		}

		if (s.bg !== undefined) {
			codes.push(`48;2;${rgb(s.bg)}`);
		}

		const next = codes.join(";");

		if (next !== style) {
			out += `\u001B[0${next === "" ? "" : `;${next}`}m`;
		}

		style = next;
		shaded = s.bg !== undefined;
		out += s.text;
	}

	return style === "" ? out : `${out}\u001B[0m`;
};

export const lobbyFrame = (
	screen: LobbyScreen,
	cols: number,
	rows: number
): string => {
	const { rows: lines, cursor } = layout(screen, cols, rows);

	const tail =
		cursor === undefined
			? "\u001B[?25l"
			: `\u001B[${cursor.row};${cursor.col + 1}H\u001B[?25h`;

	return `\u001B[H\u001B[2J${lines.map((r) => ansi(r)).join("\r\n")}${tail}`;
};
