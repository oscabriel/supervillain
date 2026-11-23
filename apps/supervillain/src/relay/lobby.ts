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
		readonly fingerprint: string;
		readonly algorithm: string;
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

const FAINT = "#3a3f4b";

const SHADOW = "#2a2d33";

const width = (s: string) => Bun.stringWidth(s);

const rowWidth = (r: Row) => r.reduce((n, s) => n + width(s.text), 0);

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

const padRow = (r: Row, n: number): Row => [
	...r,
	{ text: " ".repeat(Math.max(0, n - rowWidth(r))) },
];

const centred = (r: Row, n: number): Row => [
	{ text: " ".repeat(Math.max(0, Math.floor((n - rowWidth(r)) / 2))) },
	...r,
];

const codePoints = (s: string): Array<string> => Array.from(s, (ch) => ch);

const cut = (s: string, n: number) =>
	width(s) <= n
		? s
		: `${codePoints(s)
				.slice(0, Math.max(0, n - 1))
				.join("")}…`;

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

const title = (w: number): Array<Row> => {
	const word = wordPixels("SUPERVILLAIN", 2, color.bright);

	if (w >= 118) {
		return beside(
			[
				halfBlocks(figurePixels("&", color.heroes)),
				halfBlocks(word),
				halfBlocks(figurePixels('"', color.director)),
			],
			4
		);
	}

	if (w >= 96) {
		return halfBlocks(word);
	}

	if (w >= 50) {
		return quadrants(word);
	}

	return [[{ text: "supervillain", fg: color.brand, bold: true }]];
};

const framed = (
	head: Row,
	body: ReadonlyArray<Row>,
	w: number,
	h: number
): Array<Row> => {
	const inner = w - 2;

	const top: Row = [
		{ text: "┌─ ", fg: color.border },
		...head,
		{
			text: ` ${"─".repeat(Math.max(0, inner - rowWidth(head) - 3))}┐`,
			fg: color.border,
		},
	];

	const middle = Array.from({ length: Math.max(0, h - 2) }, (_row, i): Row => {
		const line = body[i] ?? [];

		return [
			{ text: "│", fg: color.border },
			...padRow([{ text: " " }, ...line], inner),
			{ text: "│", fg: color.border },
		];
	});

	return [
		top,
		...middle,
		[{ text: `└${"─".repeat(inner)}┘`, fg: color.border }],
	];
};

const paneTitle = (mark: string, label: string): Row => [
	{ text: `${mark} `, fg: color.dim },
	{ text: label, fg: color.bright },
];

const tableRows = (screen: LobbyScreen, w: number): Array<Row> => {
	const digits = String(screen.tables.length).length;

	return screen.tables.map((t, i): Row => {
		const on = i === screen.picked;
		const seated = `${t.seated > 0 ? "●" : "○"} ${t.seated}`;

		return [
			{ text: on ? "▌" : " ", fg: color.brand },
			{ text: ` ${String(i + 1).padStart(digits)}  `, fg: color.dim },
			{
				text: pad(
					cut(t.room, w - digits - 5 - width(seated)),
					w - digits - 4 - width(seated)
				),
				fg: on ? color.bright : color.text,
				bold: on,
			},
			{ text: seated, fg: t.seated > 0 ? color.healthy : FAINT },
		];
	});
};

const label = (s: string): Seg => ({ text: pad(s, 10), fg: color.dim });

const youRows = (screen: LobbyScreen, w: number): Array<Row> => {
	const words = (text: string, fg: string): Array<Row> => {
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

	return [
		...words("There's no account: your ssh key is who you are.", color.text),
		[],
		[label("key"), { text: cut(screen.you.algorithm, w - 10), fg: color.dim }],
		[{ text: cut(screen.you.fingerprint, w), fg: color.bright }],
		[label("terminal"), { text: cut(screen.you.term, w - 10), fg: color.dim }],
		[],
		...words(
			"These tables know your key: the relay asked each open one, without telling it who you are.",
			color.dim
		),
	];
};

const PANE_ROWS = 12;

const key = (k: string, what: string, last = false): Array<Seg> => {
	const said: Array<Seg> = [
		{ text: k, fg: color.bright },
		{ text: ` ${what}`, fg: color.dim },
	];

	return last ? said : [...said, { text: " · ", fg: FAINT }];
};

const layout = (screen: LobbyScreen, cols: number, rows: number) => {
	const w = Math.max(20, Math.min(cols - 2, 124));
	const n = screen.tables.length;
	const out: Array<Row> = [];
	const art = title(w);

	const tag: Row = [
		{ text: "a virtual tabletop you reach with ssh", fg: color.text },
		{ text: "  ·  ", fg: FAINT },
		{
			text: `${n} open table${n === 1 ? "" : "s"} know${n === 1 ? "s" : ""} your key`,
			fg: color.dim,
		},
	];

	const listH = Math.max(PANE_ROWS, n + 2);
	const below = 3 + listH + 3;
	const showArt = art.length + below <= rows;

	for (const r of showArt ? art : title(0)) {
		out.push(centred(r, w));
	}

	out.push(
		[],
		rowWidth(tag) <= w ? centred(tag, w) : centred(tag.slice(0, 1), w),
		[]
	);

	const leftW = w >= 76 ? 34 : w;

	const left = framed(
		paneTitle("¹", "tables"),
		tableRows(screen, leftW - 4),
		leftW,
		listH
	);

	if (leftW === w) {
		out.push(...left);
	} else {
		const rightW = w - leftW - 1;

		const right = framed(
			paneTitle("²", "you"),
			youRows(screen, rightW - 4),
			rightW,
			listH
		);

		for (const [i, l] of left.slice(0, listH).entries()) {
			const r = right[i] ?? [];

			out.push([...l, { text: " " }, ...r]);
		}
	}

	out.push(
		screen.said === undefined
			? []
			: [{ text: ` › ${screen.said}`, fg: color.notice }]
	);

	const byNumber = n > 1 ? key(`1-${n}`, "by number") : [];

	const hints: Row = [
		{ text: " " },
		...key("↑↓", "pick"),
		...byNumber,
		...key("Enter", "sits you down"),
		...key("Ctrl-C", "leaves", true),
	];

	out.push(
		rowWidth(hints) <= w
			? hints
			: [{ text: " Enter sits you down", fg: color.dim }]
	);
	const prompt: Row = [{ text: " > ", fg: color.brand, bold: true }];
	out.push(
		screen.typed === ""
			? [
					...prompt,
					{
						text: cut(
							`Enter sits you at ${screen.tables[screen.picked]?.room ?? ""}`,
							w - 4
						),
						fg: color.dim,
					},
				]
			: [...prompt, { text: screen.typed, fg: color.bright }]
	);
	const left0 = Math.max(0, Math.floor((cols - w) / 2));

	return {
		rows: out,
		left: left0,
		cursor: { row: out.length, col: left0 + 3 + width(screen.typed) },
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
	const { rows: lines, left, cursor } = layout(screen, cols, rows);
	const margin = " ".repeat(left);

	return `\u001B[H\u001B[2J${lines.map((r) => margin + ansi(r)).join("\r\n")}\u001B[${cursor.row};${cursor.col + 1}H`;
};
