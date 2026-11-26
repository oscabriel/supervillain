import { DINGS_ATLAS } from "../table/atlas/dings.ts";
import { TEXT_ATLAS } from "../table/atlas/text.ts";
import { color } from "../table/theme.ts";

export interface LobbyTable {
	readonly room: string;
	readonly seated: number;
}

export interface LobbyScreen {
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
		const room = pad(cut(t.room, nameW), nameW);

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
				...words("Ask your GM for a room name.", color.text, w),
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
				...words("Ask your GM for a room name.", color.text, w),
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
				{ text: "joining by room name", fg: color.text },
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
			section(current.room, w, color.bright, true),
			live,
			[],
			[
				pill("sit down", color.brand, color.cursorFg),
				{ text: "  enter", fg: color.dim },
			],
			[],
			field("direct", [
				{ text: cut(`ssh ${current.room}@…`, w - 10), fg: color.dice },
			]),
			...identityFields(screen, w),
		];
	}

	return [
		section("identity", w),
		...identityFields(screen, w),
		[],
		section("commands", w),
		field("direct", [{ text: cut("ssh <room>@…", w - 10), fg: color.dice }]),
		field("host", [
			{
				text: cut("supervillain host --room <name>", w - 10),
				fg: color.director,
			},
		]),
		field("rules", [
			{ text: cut("draw-steel · set.world · pf2e", w - 10), fg: color.text },
		]),
	];
};

const asking = (screen: LobbyScreen): string => {
	const room = screen.tables[screen.picked]?.room;

	return room === undefined
		? "type your table's room name"
		: `Enter sits at ${room}, or type another room`;
};

const hint = (k: string, what: string): Array<Seg> => [
	{ text: k, fg: color.bright, bold: true },
	{ text: ` ${what}`, fg: color.dim },
];

const joinHints = (parts: ReadonlyArray<Array<Seg>>): Row =>
	parts.flatMap((p, i) => (i === 0 ? p : [{ text: "   " }, ...p]));

const footerParts = (n: number): ReadonlyArray<Array<Seg>> => {
	if (n === 0) {
		return [
			hint("a-z", "room name"),
			hint("enter", "sit down"),
			hint("ctrl-c", "quit"),
		];
	}

	if (n === 1) {
		return [
			hint("enter", "sit down"),
			hint("a-z", "another room"),
			hint("ctrl-c", "quit"),
		];
	}

	return [
		hint("↑/↓", "pick"),
		hint(`1-${n}`, "jump"),
		hint("enter", "sit down"),
		hint("ctrl-c", "quit"),
	];
};

const footerRow = (screen: LobbyScreen, w: number): Row => {
	const full = joinHints(footerParts(screen.tables.length));

	if (rowWidth(full) <= w) {
		return centred(full, w);
	}

	const compact = joinHints([
		hint("enter", "sit down"),
		hint("ctrl-c", "quit"),
	]);

	return centred(fitRow(compact, w), w);
};

const columnGap = (w: number): number => {
	if (w >= 88) {
		return 6;
	}

	return w >= 82 ? 4 : 3;
};

const layout = (screen: LobbyScreen, cols: number, rows: number) => {
	const w = Math.max(24, Math.min(cols - 4, MAX_STAGE_WIDTH));
	const art = banner(cols);
	const n = screen.tables.length;
	const twoCol = w >= WIDE_SPLIT;
	const maxList = Math.max(4, Math.min(n, Math.max(BODY_ROWS - 1, rows - 16)));

	const bodyH = twoCol
		? Math.max(BODY_ROWS, Math.min(n, maxList) + (n > maxList ? 2 : 1))
		: Math.max(6, Math.min(n, maxList) + 2);

	const coreHeight = 3 + 1 + bodyH + 1 + 1 + 1 + 1;
	const showArt = art.length > 0 && art.length + 1 + coreHeight <= rows;
	const stage: Array<Row> = [...topBar(screen, w, cols, rows, showArt), []];

	if (twoCol) {
		const gap = columnGap(w);
		const rightW = Math.min(52, Math.max(50, Math.floor((w - gap) * 0.6)));
		const leftW = w - gap - rightW;

		const left =
			n === 0
				? emptyLeftRows(screen, leftW)
				: tableListRows(screen, leftW, maxList);

		const right = detailRows(screen, rightW);
		const height = Math.max(left.length, right.length, BODY_ROWS);

		for (let i = 0; i < height; i += 1) {
			const rightRow = right[i] ?? [];

			stage.push([
				...padRow(left[i] ?? [], leftW),
				{ text: " ".repeat(gap) },
				...rightRow,
			]);
		}
	} else {
		const narrowBody =
			n === 0 ? emptyLeftRows(screen, w) : tableListRows(screen, w, maxList);

		stage.push(...narrowBody);
	}

	const feedback: Row =
		screen.said === undefined
			? []
			: [{ text: `› ${cut(screen.said, w - 2)}`, fg: color.notice }];

	const prompt: Row = [{ text: "> ", fg: color.brand, bold: true }];
	const promptIndex = stage.length + 1;

	const promptRow: Row =
		screen.typed === ""
			? [...prompt, { text: cut(asking(screen), w - 2), fg: color.dim }]
			: [
					...prompt,
					{ text: cut(screen.typed, w - 2), fg: color.bright, bold: true },
				];

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
	const cursorCol = stageLeft + 2 + width(cut(screen.typed, w - 2));

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
