import {
	columnLabel,
	formatSquare,
	parseSquare,
	pick,
	quote,
	ifDefined,
	when,
} from "@supervillain/domain";

import type { MapToken, MapView } from "./view.ts";

export type MapTone =
	| "label"
	| "floor"
	| "wall"
	| "difficult"
	| "terrain"
	| "heroes"
	| "director"
	| "mine"
	| "dead";

export interface MapSegment {
	readonly text: string;
	readonly tone: MapTone;
	readonly reach?: boolean;
	readonly acting?: boolean;
	readonly body?: boolean;
}

export type MapLine = ReadonlyArray<MapSegment>;

export interface MapLayout {
	readonly title: string;
	readonly bottomTitle: string;
	readonly lines: ReadonlyArray<MapLine>;
	readonly reachClipped: boolean;
	readonly squares: SquareGrid;
}

export interface SquareGrid {
	readonly left: number;
	readonly top: number;
	readonly x0: number;
	readonly y0: number;
	readonly cols: number;
	readonly rows: number;
}

export const MAP_FRAME = { width: 4, height: 2 } as const;

const CELL = 2;

const ONE_LETTER = 26;

const TWO_ROW_MIN = 3;

export const mapRowsWanted = (map: MapView): number =>
	map.height + (map.width > ONE_LETTER ? 2 : 1) + MAP_FRAME.height;

interface Ground {
	readonly glyph: string;
	readonly tone: MapTone;
}

const TERRAIN = new Map<string, Ground>([
	[".", { glyph: "·", tone: "floor" }],
	["#", { glyph: "██", tone: "wall" }],
	["~", { glyph: "~", tone: "difficult" }],
	[" ", { glyph: " ", tone: "floor" }],
]);

const REACH_GLYPH = new Map([
	[".", "•"],
	["~", "≈"],
]);

const ARROWS = [
	["↖", "▴", "↗"],
	["◂", "", "▸"],
	["↙", "▾", "↘"],
] as const;

interface Axis {
	readonly origin: number;
	readonly span: number;
	readonly before: number;
	readonly after: number;
}

const MARGIN_ROOM = 6;

const axis = (
	size: number,
	room: number,
	centre: number,
	at: ReadonlyArray<number>
): Axis => {
	if (size <= room) {
		return { origin: 0, span: size, before: 0, after: 0 };
	}

	const scarce = room < MARGIN_ROOM;
	let before = 0;
	let after = 0;

	const place = () => {
		const span = Math.max(1, room - before - after);

		const origin = Math.min(
			Math.max(0, centre - Math.floor(span / 2)),
			size - span
		);

		return { origin, span };
	};

	const passes = scarce ? 0 : 2;

	for (let pass = 0; pass < passes; pass += 1) {
		const { origin, span } = place();

		if (at.some((p) => p < origin)) {
			before = 1;
		}

		if (at.some((p) => p >= origin + span)) {
			after = 1;
		}
	}

	return { ...place(), before, after };
};

export const followed = (tokens: ReadonlyArray<MapToken>) => {
	const alive = tokens.filter((t) => !t.dead);

	return alive.find((t) => t.acting) ?? alive.find((t) => t.mine);
};

const rank = (t: MapToken) =>
	(t.dead ? 0 : 8) +
	(t.acting ? 4 : 0) +
	(t.mine ? 2 : 0) +
	(t.side === "heroes" ? 1 : 0);

const better = (a: MapToken | undefined, b: MapToken) =>
	a === undefined || rank(b) > rank(a) ? b : a;

const toneOf = (t: MapToken): MapTone => {
	if (t.dead) {
		return "dead";
	}

	return t.mine ? "mine" : t.side;
};

const sideOf = (c: number, span: number) => {
	if (c < 0) {
		return -1;
	}

	return c >= span ? 1 : 0;
};

const edgeAt = (c: number, side: number, span: number) => {
	if (side === 0) {
		return c;
	}

	return side < 0 ? -1 : span;
};

const BODY = "░░";

const footprintOf = (t: MapToken) => t.footprint ?? 1;

const coversSquare = (t: MapToken, x: number, y: number) =>
	x >= t.x && x < t.x + footprintOf(t) && y >= t.y && y < t.y + footprintOf(t);

const squaresUnder = (t: MapToken) =>
	Array.from({ length: footprintOf(t) ** 2 }, (_, i) => ({
		x: t.x + (i % footprintOf(t)),
		y: t.y + Math.floor(i / footprintOf(t)),
	}));

const cell = (
	text: string,
	tone: MapTone,
	more: { reach?: boolean; acting?: boolean; body?: boolean } = {}
) => {
	const width = Bun.stringWidth(text);
	const head: MapSegment = { text, tone, ...more };

	if (width >= CELL) {
		return [head];
	}

	const fill: MapSegment = {
		text: " ".repeat(CELL - width),
		tone: more.body === true ? tone : "floor",
		...ifDefined(more.reach, (value) => ({ reach: value })),
		...when(more.body === true, () => ({ body: true })),
	};

	return [head, fill];
};

const fit = (mark: string): string => {
	let out = "";

	for (const ch of mark) {
		if (Bun.stringWidth(out + ch) > CELL) {
			break;
		}

		out += ch;
	}

	return out;
};

const blank = (width: number): MapSegment => ({
	text: " ".repeat(width),
	tone: "floor",
});

const letters = (
	origin: number,
	span: number,
	rows: number
): ReadonlyArray<string> => {
	if (rows === 2) {
		const names = Array.from({ length: span }, (_, i) =>
			columnLabel(origin + i)
		);

		const upper = names
			.map((n) => (n.length > 1 ? (n.at(0) ?? " ") : " ").padEnd(CELL))
			.join("");

		const lower = names.map((n) => (n.at(-1) ?? " ").padEnd(CELL)).join("");

		return [upper, lower];
	}

	let row = "";

	for (let i = 0; i < span; i += 1) {
		const name = columnLabel(origin + i);
		const at = i * CELL;

		if (row !== "" && at <= row.length) {
			continue;
		}

		row = row.padEnd(at) + name;
	}

	return [row.padEnd(span * CELL)];
};

const offscreenTitle = (off: ReadonlyArray<string>, width: number): string => {
	if (off.length === 0) {
		return "";
	}

	let title = "";

	for (const [n, item] of off.entries()) {
		const left = off.length - n - 1;
		const tail = left > 0 ? ` +${left}` : "";

		if (Bun.stringWidth(`${title} ${item}${tail} `) > width) {
			return `${title} +${off.length - n} `;
		}

		title += ` ${item}`;
	}

	return `${title} `;
};

export interface Focus {
	readonly x: number;
	readonly y: number;
}

export const focusOf = (
	map: MapView,
	typed: string
):
	| { readonly token: string }
	| { readonly square: Focus }
	| { readonly refusal: string } => {
	const q = typed.trim();
	const marked = map.tokens.find((t) => t.mark === q);

	if (marked !== undefined) {
		return { token: marked.id };
	}

	const square = parseSquare(q);

	if (square !== undefined) {
		return square.x < map.width && square.y < map.height
			? { square }
			: { refusal: `${formatSquare(square)} is outside the map.` };
	}

	const found = pick(
		map.tokens,
		(t) => [t.id, t.name],
		(t) => t.name,
		q,
		`No token on the map is called '${quote(q)}'; /view <square|who>, or map, feed or both`
	);

	return "refusal" in found ? found : { token: found.id };
};

export const mapLayout = (
	map: MapView,
	width: number,
	height: number,
	focus?: Focus
): MapLayout => {
	const title = ` map · ${map.name} `;
	const numbers = String(map.height).length + 1;
	const living = map.tokens.filter((t) => !t.dead);
	const roomAcross = Math.floor((width - numbers) / CELL);

	const viewAt = (centre: Focus) => {
		const across = axis(
			map.width,
			roomAcross,
			centre.x,
			living.map((t) => t.x)
		);

		const twoLetter = across.origin + across.span > ONE_LETTER;
		const labelRows = twoLetter && height - 2 >= TWO_ROW_MIN ? 2 : 1;

		const down = axis(
			map.height,
			height - labelRows,
			centre.y,
			living.map((t) => t.y)
		);

		return { across, down, labelRows };
	};

	const inView = (v: ReturnType<typeof viewAt>, t: Focus) =>
		t.x >= v.across.origin &&
		t.x < v.across.origin + v.across.span &&
		t.y >= v.down.origin &&
		t.y < v.down.origin + v.down.span;

	const middle = {
		x: Math.floor(map.width / 2),
		y: Math.floor(map.height / 2),
	};

	const crowded = () => {
		let best: { at: Focus; seen: number } | undefined;

		for (const t of living.toSorted((a, b) => rank(b) - rank(a))) {
			const view = viewAt(t);
			const seen = living.filter((u) => inView(view, u)).length;

			if (best === undefined || seen > best.seen) {
				best = { at: t, seen };
			}
		}

		return best?.at;
	};

	const view = viewAt(focus ?? followed(map.tokens) ?? crowded() ?? middle);
	const { across, down, labelRows } = view;

	const reach = new Set(map.reach.map((r) => `${r.x},${r.y}`));
	const onSquare = new Map<string, MapToken>();
	const marker = new Map<string, MapToken>();
	const off: Array<MapToken> = [];

	const shows = (x: number, y: number) =>
		x >= across.origin &&
		x < across.origin + across.span &&
		y >= down.origin &&
		y < down.origin + down.span;

	for (const t of map.tokens) {
		const cx = t.x - across.origin;
		const cy = t.y - down.origin;
		const dx = sideOf(cx, across.span);
		const dy = sideOf(cy, down.span);
		const seen = squaresUnder(t).filter((s) => shows(s.x, s.y));

		if (seen.length > 0) {
			for (const s of seen) {
				const key = `${s.x},${s.y}`;
				onSquare.set(key, better(onSquare.get(key), t));
			}
		} else if (!t.dead) {
			const key = `${edgeAt(cx, dx, across.span)},${edgeAt(cy, dy, down.span)}`;
			marker.set(key, better(marker.get(key), t));
			off.push(t);
		}
	}

	const arrowOf = (t: MapToken) => {
		const dx = sideOf(t.x - across.origin, across.span) + 1;
		const dy = sideOf(t.y - down.origin, down.span) + 1;

		return ARROWS[dy]?.[dx] ?? "";
	};

	const row = (cy: number): Array<MapSegment> => {
		const out: Array<MapSegment> = [];

		for (let cx = -across.before; cx < across.span + across.after; cx += 1) {
			const edge = cx < 0 || cx >= across.span || cy < 0 || cy >= down.span;

			if (edge) {
				const t = marker.get(`${cx},${cy}`);

				const shown =
					t === undefined
						? [blank(CELL)]
						: cell(arrowOf(t), toneOf(t), { acting: t.acting });

				out.push(...shown);
				continue;
			}

			const x = across.origin + cx;
			const y = down.origin + cy;
			const reachable = reach.has(`${x},${y}`);
			const t = onSquare.get(`${x},${y}`);

			if (t !== undefined && (t.x !== x || t.y !== y)) {
				out.push(
					...cell(t.dead ? "xx" : BODY, toneOf(t), {
						reach: reachable,
						body: true,
					})
				);
				continue;
			}

			if (t !== undefined) {
				out.push(
					...cell(t.dead ? "x" : fit(t.mark), toneOf(t), {
						reach: reachable,
						acting: t.acting && !t.dead,
						...when(footprintOf(t) > 1, () => ({ body: true })),
					})
				);
				continue;
			}

			const ch = map.terrain[y]?.[x] ?? " ";
			const terrain = TERRAIN.get(ch) ?? { glyph: ch, tone: "terrain" };

			const glyph =
				(reachable ? REACH_GLYPH.get(ch) : undefined) ?? terrain.glyph;

			out.push(...cell(glyph, terrain.tone, { reach: reachable }));
		}

		return out;
	};

	const squaresWidth = (across.span + across.before + across.after) * CELL;
	const left = Math.max(0, Math.floor((width - numbers - squaresWidth) / 2));
	const contentRows = labelRows + down.span + down.before + down.after;
	const top = Math.max(0, Math.floor((height - contentRows) / 2));

	const lead = (label: string): MapSegment => ({
		text: `${" ".repeat(left) + label.padStart(numbers - 1)} `,
		tone: "label",
	});

	const lines: Array<MapLine> = Array.from({ length: top }, () => [blank(1)]);

	for (const text of letters(across.origin, across.span, labelRows)) {
		lines.push([
			lead(""),
			blank(across.before * CELL),
			{ text, tone: "label" },
		]);
	}

	for (let cy = -down.before; cy < down.span + down.after; cy += 1) {
		const shown = cy >= 0 && cy < down.span;
		lines.push([lead(shown ? String(down.origin + cy + 1) : ""), ...row(cy)]);
	}

	const cropped = [
		down.span < map.height
			? `rows ${down.origin + 1}-${down.origin + down.span} of ${map.height}`
			: "",
		across.span < map.width
			? `columns ${columnLabel(across.origin)}-${columnLabel(across.origin + across.span - 1)} of a-${columnLabel(map.width - 1)}`
			: "",
	].filter((part) => part !== "");

	return {
		squares: {
			left: left + numbers + across.before * CELL,
			top: top + labelRows + down.before,
			x0: across.origin,
			y0: down.origin,
			cols: across.span,
			rows: down.span,
		},
		title:
			cropped.length === 0
				? title
				: `${title.trimEnd()} · ${cropped.join(", ")} `,
		reachClipped: map.reach.some((r) => !inView(view, r)),
		bottomTitle: offscreenTitle(
			off.map((t) => `${arrowOf(t)}${t.mark}`),
			width
		),
		lines,
	};
};

export const squareAt = (
	grid: SquareGrid,
	col: number,
	row: number
): Focus | undefined => {
	if (col < grid.left || row < grid.top) {
		return undefined;
	}

	const sx = Math.floor((col - grid.left) / CELL);
	const sy = row - grid.top;

	if (sx >= grid.cols || sy >= grid.rows) {
		return undefined;
	}

	return { x: grid.x0 + sx, y: grid.y0 + sy };
};

export const tokenAt = (map: MapView, square: Focus): MapToken | undefined => {
	let found: MapToken | undefined;

	for (const t of map.tokens) {
		if (coversSquare(t, square.x, square.y)) {
			found = better(found, t);
		}
	}

	return found;
};
