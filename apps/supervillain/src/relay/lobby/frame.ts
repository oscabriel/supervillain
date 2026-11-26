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

const RULE = "#464c5a";

const SHADOW = "#2a2d33";

const MIN_TABLE_COLS = 72;

const MIN_TABLE_ROWS = 20;

const MAX_STAGE_WIDTH = 90;

const WIDE_SPLIT = 76;

const BODY_ROWS = 8;

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

const section = (
	title: string,
	w: number,
	fg: string = color.dim,
	bold = false
): Row => {
	const label = cut(title, Math.max(1, w - 2));
	const rule = Math.max(0, w - width(label) - 1);
	const head: Seg = { text: label, fg, bold };

	if (rule === 0) {
		return [head];
	}

	return [head, { text: ` ${"─".repeat(rule)}`, fg: RULE }];
};

const field = (name: string, value: Row): Row => [
	{ text: pad(name, 10), fg: color.dim },
	...value,
];

const pill = (text: string, bg: string, fg: string): Seg => ({
	text: ` ${text} `,
	fg,
	bg,
	bold: true,
});

const tabOf = (screen: LobbyScreen): LobbyTab => screen.tab ?? "tables";

const formOf = (screen: LobbyScreen): CreateForm =>
	screen.create ?? createForm(screen.you.key === undefined, undefined);

const isTypingName = (typed: string): boolean =>
	typed !== "" && !/^\d+$/u.test(typed);

const cell = (content: Row, inner: number): Row => {
	const fitted = fitRow(content, Math.max(1, inner - 2));
	const used = rowWidth(fitted);
	const left = Math.max(0, Math.floor((inner - used) / 2));
	const right = Math.max(0, inner - used - left);
	const out: Array<Seg> = [];

	if (left > 0) {
		out.push({ text: " ".repeat(left) });
	}

	out.push(...fitted);

	if (right > 0) {
		out.push({ text: " ".repeat(right) });
	}

	return out;
};

const statusCell = (n: number, guest: boolean): Row => {
	if (n > 0) {
		return [
			{ text: "● ", fg: color.healthy },
			{
				text: `${n} open table${n === 1 ? "" : "s"}`,
				fg: color.bright,
				bold: true,
			},
		];
	}

	if (guest) {
		return [
			{ text: "○ ", fg: color.gm },
			{ text: "guest session", fg: color.text },
		];
	}

	return [
		{ text: "○ ", fg: color.dim },
		{ text: "no open tables", fg: color.dim },
	];
};

const topBar = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number,
	showArt: boolean
): Array<Row> => {
	const n = screen.tables.length;
	const guest = screen.you.key === undefined;
	const tight = cols < MIN_TABLE_COLS || rows < MIN_TABLE_ROWS;

	const brandCell: Row = showArt
		? [
				{ text: "◆ ", fg: color.brand },
				{ text: "lobby", fg: color.bright, bold: true },
				{ text: " · ssh tabletop", fg: color.dim },
			]
		: [
				{ text: "◆ ", fg: color.brand },
				{ text: "supervillain", fg: color.brand, bold: true },
				{ text: " · lobby", fg: color.dim },
			];

	const tablesCell = statusCell(n, guest);
	const sizeText = `${cols}×${rows}`;

	const cells: ReadonlyArray<Row> =
		w >= 72
			? [
					brandCell,
					tablesCell,
					tight
						? [{ text: `! ${sizeText} (min 72×20)`, fg: color.notice }]
						: [
								{ text: screen.you.term, fg: color.text },
								{ text: ` · ${sizeText}`, fg: color.dim },
							],
				]
			: [
					showArt
						? [
								{ text: "◆ ", fg: color.brand },
								{ text: "lobby", fg: color.bright, bold: true },
							]
						: [
								{ text: "◆ ", fg: color.brand },
								{ text: "supervillain", fg: color.brand, bold: true },
							],
					tablesCell,
				];

	const separators = cells.length + 1;
	const innerTotal = Math.max(cells.length * 4, w - separators);
	const base = Math.floor(innerTotal / cells.length);
	const extra = innerTotal - base * cells.length;
	const widths = cells.map((_c, i) => base + (i < extra ? 1 : 0));
	const termWidth = widths.at(2);

	const fittedCells =
		w >= 72 && !tight && termWidth !== undefined
			? [
					brandCell,
					tablesCell,
					[
						{
							text: cut(
								screen.you.term,
								Math.max(4, termWidth - 2 - width(` · ${sizeText}`))
							),
							fg: color.text,
						},
						{ text: ` · ${sizeText}`, fg: color.dim },
					],
				]
			: cells;

	const top: Row = [
		{
			text: `┌${widths.map((cw) => "─".repeat(cw)).join("┬")}┐`,
			fg: RULE,
		},
	];

	const mid: Row = [
		{ text: "│", fg: RULE },
		...fittedCells.flatMap((c, i): Row => [
			...cell(c, widths[i] ?? 0),
			{ text: "│", fg: RULE },
		]),
	];

	const bottom: Row = [
		{
			text: `└${widths.map((cw) => "─".repeat(cw)).join("┴")}┘`,
			fg: RULE,
		},
	];

	return [top, mid, bottom];
};

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

const tableListRows = (
	screen: LobbyScreen,
	w: number,
	maxItems: number
): Array<Row> => {
	const { tables, picked } = screen;
	const digits = String(tables.length).length;
	const typingOther = isTypingName(screen.typed);
	const shown = Math.min(tables.length, Math.max(1, maxItems));

	const start = Math.max(
		0,
		Math.min(picked - Math.floor(shown / 2), tables.length - shown)
	);

	const slice = tables.slice(start, start + shown);
	const rows: Array<Row> = [section("tables", w)];

	for (const [offset, t] of slice.entries()) {
		const i = start + offset;
		const on = i === picked;
		const num = String(i + 1).padStart(digits);
		const seated = `${t.seated > 0 ? "●" : "○"} ${t.seated}`;
		const nameW = Math.max(4, w - digits - 5 - width(seated));
		const room = pad(cut(tableAddress(t), nameW), nameW);

		if (on && !typingOther) {
			rows.push([
				{
					text: ` ${num}  ${room} ${seated} `,
					fg: color.cursorFg,
					bg: color.brand,
					bold: true,
				},
			]);
		} else if (on) {
			rows.push([
				{
					text: ` ${num}  ${room} ${seated} `,
					fg: color.bright,
					bg: color.mineBg,
				},
			]);
		} else {
			rows.push([
				{ text: ` ${num}  `, fg: color.dim },
				{ text: `${room} `, fg: color.text },
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

	return rows;
};

const emptyLeftRows = (screen: LobbyScreen, w: number): Array<Row> => {
	const guest = screen.you.key === undefined;

	return guest
		? [
				section("tables", w),
				[
					{ text: "○ ", fg: color.gm },
					{ text: cut("unavailable as guest", w - 2), fg: color.text },
				],
				[],
				...words("Tables need an ssh key to remember your seat.", color.dim, w),
				[],
				...words("Ask your GM for the table's name.", color.text, w),
			]
		: [
				section("tables", w),
				[
					{ text: "○ ", fg: color.dim },
					{ text: cut("none open yet", w - 2), fg: color.dim },
				],
				[],
				...words(
					"Played tables appear here whenever their GM is live.",
					color.dim,
					w
				),
				[],
				...words("Ask your GM for the table's name.", color.text, w),
			];
};

const identityFields = (screen: LobbyScreen, w: number): Array<Row> => {
	const yours = screen.you.key;

	if (yours === undefined) {
		return [
			field("key", [
				{ text: "none", fg: color.gm },
				{ text: cut(" · ephemeral seat", Math.max(0, w - 14)), fg: color.dim },
			]),
			field("make one", [
				{ text: cut("ssh-keygen -t ed25519", w - 10), fg: color.bright },
			]),
		];
	}

	const algo = cut(yours.algorithm, Math.max(4, w - 10));
	const noteSpace = w - 10 - width(algo);
	const keyValue: Array<Seg> = [{ text: algo, fg: color.heroes }];

	if (noteSpace >= 13) {
		keyValue.push({ text: " · no account", fg: color.dim });
	}

	return [
		field("key", keyValue),
		[{ text: cut(yours.fingerprint, w), fg: color.bright }],
	];
};

const detailRows = (screen: LobbyScreen, w: number): Array<Row> => {
	const typingOther = isTypingName(screen.typed);
	const current = screen.tables[screen.picked];

	if (typingOther) {
		return [
			section(screen.typed, w, color.bright, true),
			[
				{ text: "◈ ", fg: color.brand },
				{ text: "joining by table name", fg: color.text },
			],
			[],
			[
				pill("sit down", color.brand, color.cursorFg),
				{ text: "  enter", fg: color.dim },
			],
			[],
			field("direct", [
				{ text: cut(`ssh ${screen.typed}@…`, w - 10), fg: color.dice },
			]),
			...identityFields(screen, w),
		];
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

		return [
			section(tableAddress(current), w, color.bright, true),
			live,
			[],
			[
				pill("sit down", color.brand, color.cursorFg),
				{ text: "  enter", fg: color.dim },
			],
			[],
			field("direct", [
				{ text: cut(`ssh ${tableAddress(current)}@…`, w - 10), fg: color.dice },
			]),
			...identityFields(screen, w),
		];
	}

	return [
		section("identity", w),
		...identityFields(screen, w),
		[],
		section("commands", w),
		field("direct", [
			{ text: cut("ssh <handle>/<table>@…", w - 10), fg: color.dice },
		]),
		field("host", [
			{
				text: cut("supervillain host --handle <you> --relay", w - 10),
				fg: color.director,
			},
		]),
		field("rules", [
			{ text: cut("draw-steel · set.world · pf2e", w - 10), fg: color.text },
		]),
	];
};

const asking = (screen: LobbyScreen): string => {
	const current = screen.tables[screen.picked];

	return current === undefined
		? "type your table's name"
		: `Enter sits at ${tableAddress(current)}, or type another table`;
};

const hint = (k: string, what: string): Array<Seg> => [
	{ text: k, fg: color.bright, bold: true },
	{ text: ` ${what}`, fg: color.dim },
];

const joinHints = (parts: ReadonlyArray<Array<Seg>>): Row =>
	parts.flatMap((p, i) => (i === 0 ? p : [{ text: "   " }, ...p]));

const MORE_TABS = hint("tab", "more");

const tableFooter = (n: number): ReadonlyArray<Array<Seg>> => {
	if (n === 0) {
		return [
			hint("a-z", "table name"),
			hint("enter", "sit down"),
			hint("ctrl-c", "quit"),
			MORE_TABS,
		];
	}

	if (n === 1) {
		return [
			hint("enter", "sit down"),
			hint("a-z", "another table"),
			hint("ctrl-c", "quit"),
			MORE_TABS,
		];
	}

	return [
		hint("↑/↓", "pick"),
		hint(`1-${n}`, "jump"),
		hint("enter", "sit down"),
		hint("ctrl-c", "quit"),
		MORE_TABS,
	];
};

const createFooter = (form: CreateForm): ReadonlyArray<Array<Seg>> => {
	if (form.guest || form.step === "ready") {
		return [hint("tab", "other tabs"), hint("ctrl-c", "quit")];
	}

	if (form.step === "handle") {
		return form.held === undefined
			? [
					hint("a-z", "handle"),
					hint("enter", "claim it"),
					hint("tab", "other tabs"),
					hint("ctrl-c", "quit"),
				]
			: [
					hint("enter", "next"),
					hint("tab", "other tabs"),
					hint("ctrl-c", "quit"),
				];
	}

	return [
		hint("a-z", "table name"),
		hint("←/→", "rules"),
		hint("enter", "make the code"),
		hint("ctrl-c", "quit"),
	];
};

const footerParts = (screen: LobbyScreen): ReadonlyArray<Array<Seg>> => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return [
			hint("enter", "try a table"),
			hint("tab", "other tabs"),
			hint("ctrl-c", "quit"),
		];
	}

	return tab === "create"
		? createFooter(formOf(screen))
		: tableFooter(screen.tables.length);
};

const footerRow = (screen: LobbyScreen, w: number): Row => {
	const full = joinHints(footerParts(screen));

	if (rowWidth(full) <= w) {
		return centred(full, w);
	}

	const compact = joinHints([hint("tab", "tabs"), hint("ctrl-c", "quit")]);

	return centred(fitRow(compact, w), w);
};

const columnGap = (w: number): number => {
	if (w >= 88) {
		return 6;
	}

	return w >= 82 ? 4 : 3;
};

const TAB_TITLES: Readonly<Record<LobbyTab, string>> = {
	tables: "Tables",
	try: "Try a Table",
	create: "Create a Table",
};

const tabBar = (tab: LobbyTab, w: number): Row => {
	const parts = TABS.flatMap((each, i): Row => {
		const label = ` ${i + 1} ${TAB_TITLES[each]} `;
		const gap: Row = i === 0 ? [] : [{ text: " " }];

		return each === tab
			? [
					...gap,
					{ text: label, fg: color.cursorFg, bg: color.brand, bold: true },
				]
			: [...gap, { text: label, fg: color.text, bg: color.mineBg }];
	});

	return fitRow(parts, w);
};

const tablesBody = (screen: LobbyScreen, w: number, rows: number) => {
	const n = screen.tables.length;
	const maxList = Math.max(4, Math.min(n, Math.max(BODY_ROWS - 1, rows - 17)));

	if (w < WIDE_SPLIT) {
		return n === 0
			? emptyLeftRows(screen, w)
			: tableListRows(screen, w, maxList);
	}

	const gap = columnGap(w);
	const rightW = Math.min(52, Math.max(50, Math.floor((w - gap) * 0.6)));
	const leftW = w - gap - rightW;

	const left =
		n === 0
			? emptyLeftRows(screen, leftW)
			: tableListRows(screen, leftW, maxList);

	const right = detailRows(screen, rightW);
	const height = Math.max(left.length, right.length, BODY_ROWS);
	const body: Array<Row> = [];

	for (let i = 0; i < height; i += 1) {
		const leftRow = left[i] ?? [];
		const rightRow = right[i] ?? [];

		body.push([
			...padRow(leftRow, leftW),
			{ text: " ".repeat(gap) },
			...rightRow,
		]);
	}

	return body;
};

const tryBody = (screen: LobbyScreen, w: number): Array<Row> => {
	const { sandbox } = screen;

	const action: Row =
		sandbox?.open === true
			? [
					pill("try a table", color.brand, color.cursorFg),
					{ text: "  enter", fg: color.dim },
				]
			: [
					{ text: "○ ", fg: color.dim },
					{
						text: cut("this relay offers no sandbox tables", w - 2),
						fg: color.dim,
					},
				];

	const limits: Array<Row> =
		sandbox === undefined
			? []
			: [
					field("needs", [
						{
							text: cut(
								`a terminal of ${sandbox.cols}×${sandbox.rows} or more`,
								w - 10
							),
							fg: color.text,
						},
					]),
					field("closes", [
						{
							text: cut(
								`after ${sandbox.idleMinutes} min idle, ${sandbox.maxMinutes} min in all`,
								w - 10
							),
							fg: color.text,
						},
					]),
				];

	return [
		section("try a table", w),
		[
			{ text: "◆ ", fg: color.brand },
			{
				text: cut("a Draw Steel table to play by yourself", w - 2),
				fg: color.bright,
				bold: true,
			},
		],
		[],
		...words(
			"You sit as the GM of the sample encounter: Brann and Ilsa on the Ford Road against the bandits. Roll, move tokens and run the fight; /help lists the commands.",
			color.text,
			w
		),
		[],
		...words(
			"Nothing is saved: the table lives in the relay's memory and is gone when you leave.",
			color.dim,
			w
		),
		[],
		action,
		[],
		...limits,
	];
};

const stepsRow = (form: CreateForm, w: number): Row => {
	const steps: ReadonlyArray<readonly [CreateForm["step"], string]> = [
		["handle", "1 handle"],
		["table", "2 table & rules"],
		["ready", "3 ready"],
	];

	return fitRow(
		steps.flatMap(([step, label], i): Row => {
			const on = step === form.step;
			const sep: Row = i === 0 ? [] : [{ text: " › ", fg: color.dim }];

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

const chosenFields = (form: CreateForm, w: number): Array<Row> => [
	field("handle", [{ text: cut(form.handle, w - 10), fg: color.bright }]),
	field("table", [
		{
			text: cut(form.table === "" ? "…" : form.table, w - 10),
			fg: form.table === "" ? color.dim : color.bright,
		},
	]),
	fitRow(field("rules", rulesRow(form, form.step === "table")), w),
];

const createBody = (screen: LobbyScreen, w: number): Array<Row> => {
	const form = formOf(screen);

	if (form.guest) {
		return [
			section("create a table", w),
			[
				{ text: "○ ", fg: color.gm },
				{ text: cut("needs an ssh key", w - 2), fg: color.text },
			],
			[],
			...words(KEYLESS_CREATE, color.text, w),
			[],
			field("make one", [
				{ text: cut("ssh-keygen -t ed25519", w - 10), fg: color.bright },
			]),
		];
	}

	const head = [section("create a table", w), stepsRow(form, w), []];

	if (form.step === "handle") {
		return form.held === undefined
			? [
					...head,
					...words(
						"Pick your GM handle. Players type it before your table's name, and it belongs to this SSH key.",
						color.text,
						w
					),
					[],
					field("handle", [
						{
							text: cut(form.handle === "" ? "…" : form.handle, w - 10),
							fg: form.handle === "" ? color.dim : color.bright,
						},
					]),
					field("rule", [{ text: cut(HANDLE_RULE, w - 10), fg: color.dim }]),
				]
			: [
					...head,
					[
						{ text: "● ", fg: color.healthy },
						{ text: "You hold ", fg: color.text },
						{ text: cut(form.held, w - 11), fg: color.bright, bold: true },
					],
					...words(
						`Players will join with ssh ${form.held}/<table>@…`,
						color.dim,
						w
					),
					[],
					[
						pill("next", color.brand, color.cursorFg),
						{ text: "  enter", fg: color.dim },
					],
				];
	}

	if (form.step === "table" || form.ready === undefined) {
		return [
			...head,
			...chosenFields(form, w),
			[],
			...words(
				"Enter makes a pairing code that lets your own computer's GM key host under this handle.",
				color.dim,
				w
			),
		];
	}

	const commands = commandsOf(form, form.ready);

	const shell = [commands.install, commands.create].flatMap((command) =>
		shellLines(command, w).map((line): Row => [{ text: line, fg: color.dice }])
	);

	return [
		...head,
		section("run on your computer", w, color.bright, true),
		...shell,
		[],
		...words(
			"The code works once, for 15 minutes. It's on your clipboard too, if your terminal allows it.",
			color.dim,
			w
		),
		[],
		...chosenFields(form, w),
	];
};

interface PromptText {
	readonly typed: string;
	readonly asked: string;
}

const createPrompt = (form: CreateForm): PromptText => {
	if (form.guest) {
		return { typed: "", asked: "run ssh-keygen -t ed25519, then reconnect" };
	}

	if (form.step === "handle") {
		return form.held === undefined
			? { typed: form.handle, asked: "type the handle you want" }
			: { typed: "", asked: `Enter keeps ${form.held}` };
	}

	return form.step === "table"
		? { typed: form.table, asked: "type your table's name" }
		: { typed: "", asked: "copy the commands above; Ctrl-C leaves" };
};

const promptOf = (screen: LobbyScreen): PromptText => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return {
			typed: "",
			asked:
				screen.sandbox?.open === true
					? "Enter opens your sandbox table"
					: "Tab for another tab",
		};
	}

	return tab === "create"
		? createPrompt(formOf(screen))
		: { typed: screen.typed, asked: asking(screen) };
};

const saidOf = (screen: LobbyScreen): string | undefined =>
	tabOf(screen) === "create" ? formOf(screen).said : screen.said;

const bodyOf = (screen: LobbyScreen, w: number, rows: number): Array<Row> => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return tryBody(screen, w);
	}

	return tab === "create" ? createBody(screen, w) : tablesBody(screen, w, rows);
};

const FIXED_ROWS = 3 + 1 + 1 + 1 + 1 + 1 + 1;

const layout = (screen: LobbyScreen, cols: number, rows: number) => {
	const w = Math.max(24, Math.min(cols - 4, MAX_STAGE_WIDTH));
	const art = banner(cols);
	const whole = bodyOf(screen, w, rows);
	const body = whole.slice(0, Math.max(1, rows - FIXED_ROWS));
	const coreHeight = FIXED_ROWS + body.length;
	const showArt = art.length > 0 && art.length + 1 + coreHeight <= rows;

	const stage: Array<Row> = [
		...topBar(screen, w, cols, rows, showArt),
		tabBar(tabOf(screen), w),
		[],
		...body,
	];

	const said = saidOf(screen);

	const feedback: Row =
		said === undefined
			? []
			: [{ text: `› ${cut(said, w - 2)}`, fg: color.notice }];

	const prompt: Row = [{ text: "> ", fg: color.brand, bold: true }];
	const promptIndex = stage.length + 1;
	const { typed, asked } = promptOf(screen);

	const promptRow: Row =
		typed === ""
			? [...prompt, { text: cut(asked, w - 2), fg: color.dim }]
			: [...prompt, { text: cut(typed, w - 2), fg: color.bright, bold: true }];

	stage.push(
		feedback,
		promptRow,
		[{ text: "─".repeat(w), fg: RULE }],
		footerRow(screen, w)
	);

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

	const cursorRow = topPad + positionedArt.length + promptIndex + 1;
	const cursorCol = stageLeft + 2 + width(cut(typed, w - 2));

	return {
		rows: out,
		cursor: { row: cursorRow, col: cursorCol },
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

	return `\u001B[H\u001B[2J${lines.map((r) => ansi(r)).join("\r\n")}\u001B[${cursor.row};${cursor.col + 1}H`;
};
