import { DINGS_ATLAS } from "../table/atlas/dings.ts";
import { TEXT_ATLAS } from "../table/atlas/text.ts";
import { color } from "../table/theme.ts";
import { NAV_TABS } from "./tabs.ts";
import type { NavTab } from "./tabs.ts";

export interface Seg {
	readonly text: string;
	readonly fg?: string;
	readonly bg?: string;
	readonly bold?: boolean;
}

export type Row = ReadonlyArray<Seg>;

export interface BodyCursor {
	readonly row: number;
	readonly col: number;
}

export interface BodyView {
	readonly rows: Array<Row>;
	readonly cursor?: BodyCursor | undefined;
}

interface TabItem {
	readonly tab: NavTab;
	readonly segs: Array<Seg>;
	readonly w: number;
}

interface TabSpan {
	readonly start: number;
	readonly end: number;
	readonly on: boolean;
}

interface NavBarOptions {
	readonly active: NavTab;
	readonly editing: boolean;
	readonly tableCount: number;
	readonly subtitle: string;
	readonly w: number;
	readonly cols: number;
	readonly rows: number;
	readonly showArt: boolean;
}

export type StageBody = (w: number) => BodyView;

export interface StageOptions {
	readonly active: NavTab;
	readonly editing: boolean;
	readonly tableCount: number;
	readonly subtitle: string;
	readonly cols: number;
	readonly rows: number;
	readonly bodies: Readonly<Record<NavTab, StageBody>>;
	readonly footer: (w: number) => Row;
	readonly said: string | undefined;
}

export interface FrameLayout {
	readonly rows: Array<Row>;
	readonly cursor: BodyCursor | undefined;
}

export const RULE = "#464c5a";

const SHADOW = "#2a2d33";

export const MIN_TABLE_COLS = 72;

export const MIN_TABLE_ROWS = 20;

const MAX_STAGE_WIDTH = 88;

const MIN_SIZE = `(min ${MIN_TABLE_COLS}×${MIN_TABLE_ROWS})`;

export const WIDE_SPLIT = 74;

export const BODY_ROWS = 10;

export const width = (s: string): number => Bun.stringWidth(s);

export const rowWidth = (r: Row): number =>
	r.reduce((n, s) => n + width(s.text), 0);

export const pad = (s: string, n: number): string =>
	s + " ".repeat(Math.max(0, n - width(s)));

const padRow = (r: Row, n: number): Row => {
	const extra = Math.max(0, n - rowWidth(r));

	return extra === 0 ? r : [...r, { text: " ".repeat(extra) }];
};

export const centred = (r: Row, n: number): Row => {
	const left = Math.max(0, Math.floor((n - rowWidth(r)) / 2));

	return left === 0 ? r : [{ text: " ".repeat(left) }, ...r];
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const cut = (s: string, n: number): string => {
	if (width(s) <= n) {
		return s;
	}

	let kept = "";
	let left = n - 1;

	for (const { segment } of GRAPHEMES.segment(s)) {
		left -= width(segment);

		if (left < 0) {
			break;
		}

		kept += segment;
	}

	return `${kept}…`;
};

export const fitsTable = (cols: number, rows: number): boolean =>
	cols >= MIN_TABLE_COLS && rows >= MIN_TABLE_ROWS;

export const windowText = (cols: number, rows: number): string =>
	fitsTable(cols, rows) ? `${cols}×${rows}` : `${cols}×${rows} ${MIN_SIZE}`;

export const fitRow = (r: Row, max: number): Row => {
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

type BannerTier = "flanked" | "blocks" | "quadrants" | "none";

const bannerTier = (cols: number): BannerTier => {
	if (cols >= 112) {
		return "flanked";
	}

	if (cols >= 88) {
		return "blocks";
	}

	return cols >= 50 ? "quadrants" : "none";
};

const drawBanner = (tier: BannerTier): ReadonlyArray<Row> => {
	if (tier === "flanked") {
		return beside(
			[
				halfBlocks(figurePixels("&", color.heroes)),
				halfBlocks(wordPixels("SUPERVILLAIN", 1, color.bright)),
				halfBlocks(figurePixels('"', color.director)),
			],
			3
		);
	}

	if (tier === "blocks") {
		return halfBlocks(wordPixels("SUPERVILLAIN", 1, color.bright));
	}

	return tier === "quadrants"
		? quadrants(wordPixels("SUPERVILLAIN", 2, color.bright))
		: [];
};

const banners = new Map<BannerTier, ReadonlyArray<Row>>();

export const banner = (cols: number): ReadonlyArray<Row> => {
	const tier = bannerTier(cols);
	const known = banners.get(tier);

	if (known !== undefined) {
		return known;
	}

	const drawn = drawBanner(tier);
	banners.set(tier, drawn);

	return drawn;
};

export const heading = (
	title: string,
	w: number,
	fg: string = color.dim
): Row => [{ text: cut(title, w), fg, bold: fg === color.bright }];

export const field = (name: string, value: Row, labelWidth = 10): Row => [
	{ text: pad(name, labelWidth), fg: color.dim },
	...value,
];

export const words = (text: string, fg: string, w: number): Array<Row> => {
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

export const columnGap = (w: number): number => {
	if (w >= 84) {
		return 6;
	}

	return w >= 78 ? 4 : 3;
};

export const twoColumns = (
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

const TAB_LONG: Readonly<Record<NavTab, string>> = {
	tables: "Tables",
	try: "Try a Table",
	create: "Create a Table",
	session: "Session",
};

const TAB_SHORT: Readonly<Record<NavTab, string>> = {
	tables: "Tables",
	try: "Try",
	create: "Create",
	session: "Session",
};

const TAB_TINY: Readonly<Record<NavTab, string>> = {
	tables: "Tab",
	try: "Try",
	create: "New",
	session: "Info",
};

const tabNamesFor = (w: number): Readonly<Record<NavTab, string>> => {
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

const navBar = (options: NavBarOptions): Array<Row> => {
	const { active, editing, tableCount, subtitle, w, cols, rows, showArt } =
		options;

	const names = tabNamesFor(w);
	const tight = !fitsTable(cols, rows);
	const gapSize = navGap(w);
	const header: Array<Row> = [];

	if (!showArt || tight) {
		const left: Row = showArt
			? []
			: [
					{ text: "◆ ", fg: color.brand },
					{ text: "supervillain", fg: color.brand, bold: true },
					{ text: ` · ${subtitle}`, fg: color.dim },
				];

		const warn: Row = tight
			? [{ text: `! ${windowText(cols, rows)}`, fg: color.notice }]
			: [];

		header.push(headerRow(left, warn, w));
	}

	const items: Array<TabItem> = NAV_TABS.map((tab, i) => {
		const on = tab === active;
		const keyFg = tabKeyColor(on, editing);
		const labelFg = on ? color.bright : color.dim;

		const segs: Array<Seg> = [
			{ text: ` ${i + 1} `, fg: keyFg, bold: !editing || on },
			{ text: names[tab], fg: labelFg, bold: on },
		];

		if (tab === "tables" && tableCount > 0) {
			segs.push({
				text: ` · ${tableCount}`,
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

export const hint = (k: string, what: string): Array<Seg> => [
	{ text: k, fg: color.bright, bold: true },
	{ text: ` ${what}`, fg: color.dim },
];

export const joinHints = (parts: ReadonlyArray<Array<Seg>>): Row =>
	parts.flatMap((p, i) => (i === 0 ? p : [{ text: "   " }, ...p]));

export const layoutStage = (options: StageOptions): FrameLayout => {
	const { active, editing, tableCount, subtitle, cols, rows, said } = options;
	const w = Math.max(24, Math.min(cols - 4, MAX_STAGE_WIDTH));
	const art = banner(cols);
	const tight = !fitsTable(cols, rows);
	const view = options.bodies[active](w);

	const minBody = Math.min(BODY_ROWS, Math.max(1, rows - 9));
	const naturalBody = Math.max(view.rows.length, minBody);
	const chromeWithArt = (tight ? 1 : 0) + 2 + 1 + 1 + 1 + 1;

	const showArt =
		art.length > 0 && art.length + 1 + chromeWithArt + naturalBody <= rows;

	const nav = navBar({
		active,
		editing,
		tableCount,
		subtitle,
		w,
		cols,
		rows,
		showArt,
	});

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
		options.footer(w),
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

export const renderFrame = (frame: FrameLayout): string => {
	const tail =
		frame.cursor === undefined
			? "\u001B[?25l"
			: `\u001B[${frame.cursor.row};${frame.cursor.col + 1}H\u001B[?25h`;

	return `\u001B[H\u001B[2J${frame.rows.map((r) => ansi(r)).join("\r\n")}${tail}`;
};
