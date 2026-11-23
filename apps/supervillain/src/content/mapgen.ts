import { LEGEND } from "@supervillain/domain";
import type { MapKind } from "@supervillain/domain";

export interface GeneratedMap {
	readonly name: string;
	readonly lines: ReadonlyArray<string>;
	readonly deploy: {
		readonly west: ReadonlyArray<Sq>;
		readonly east: ReadonlyArray<Sq>;
	};
}

interface Sq {
	readonly x: number;
	readonly y: number;
}

const TWO_32 = 4_294_967_296;

const u32 = (n: number) =>
	Number.isFinite(n) ? ((Math.trunc(n) % TWO_32) + TWO_32) % TWO_32 : 0;

const shiftRight = (n: number, by: number) => Math.floor(u32(n) / 2 ** by);

const bitwise = (
	a: number,
	b: number,
	keep: (x: boolean, y: boolean) => boolean
) => {
	const ua = u32(a);
	const ub = u32(b);
	let out = 0;

	for (let place = 1; place < TWO_32; place *= 2) {
		const x = Math.floor(ua / place) % 2 === 1;
		const y = Math.floor(ub / place) % 2 === 1;

		if (keep(x, y)) {
			out += place;
		}
	}

	return out;
};

const xor = (a: number, b: number) => bitwise(a, b, (x, y) => x !== y);

const or = (a: number, b: number) => bitwise(a, b, (x, y) => x || y);

const rng = (seed: number) => {
	let a = u32(seed);

	const next = () => {
		a = u32(a + 0x6d_2b_79_f5);
		let t = Math.imul(xor(a, shiftRight(a, 15)), or(a, 1));
		t = xor(t, t + Math.imul(xor(t, shiftRight(t, 7)), or(t, 61)));

		return xor(t, shiftRight(t, 14)) / TWO_32;
	};

	const pick = <T>(xs: ReadonlyArray<T>, fallback: T): T =>
		xs[Math.floor(next() * xs.length)] ?? fallback;

	return {
		next,
		int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
		chance: (p: number) => next() < p,
		pick: <T>(xs: readonly [T, ...ReadonlyArray<T>]): T => pick(xs, xs[0]),
	};
};

type Rng = ReturnType<typeof rng>;

const ease = (t: number) => t * t * (3 - 2 * t);

const noise = (r: Rng, w: number, h: number, scale: number) => {
	const gw = Math.ceil(w / scale) + 2;
	const gh = Math.ceil(h / scale) + 2;
	const g = Array.from({ length: gw * gh }, () => r.next());
	const at = (x: number, y: number) => g[y * gw + x] ?? 0;

	return (x: number, y: number) => {
		const fx = x / scale;
		const fy = y / scale;
		const x0 = Math.floor(fx);
		const y0 = Math.floor(fy);
		const tx = ease(fx - x0);
		const ty = ease(fy - y0);
		const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
		const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;

		return top + (bottom - top) * ty;
	};
};

class Grid {
	readonly w: number;
	readonly h: number;
	readonly cells: Array<Array<string>>;

	constructor(w: number, h: number, fill: string) {
		this.w = w;
		this.h = h;
		this.cells = Array.from({ length: h }, () =>
			Array.from({ length: w }, () => fill)
		);
	}
	in(x: number, y: number) {
		return x >= 0 && y >= 0 && x < this.w && y < this.h;
	}
	get(x: number, y: number) {
		return this.in(x, y) ? (this.cells[y]?.[x] ?? " ") : " ";
	}
	set(x: number, y: number, c: string) {
		const row = this.cells[y];

		if (row !== undefined && this.in(x, y)) {
			row[x] = c;
		}
	}
	rules(x: number, y: number) {
		return LEGEND.get(this.get(x, y))?.terrain ?? "#";
	}
	lines() {
		return this.cells.map((row) => row.join(""));
	}
}

const GROUND_RAMP: ReadonlyArray<readonly [number, string]> = [
	[0.3, "q"],
	[0.5, "Q"],
	[0.72, "u"],
	[0.86, "w"],
];

const groundAt = (v: number) =>
	GROUND_RAMP.find(([below]) => v < below)?.[1] ?? "e";

const ground = (g: Grid, r: Rng, lush: number) => {
	const n = noise(r, g.w, g.h, 4);
	const m = noise(r, g.w, g.h, 2);

	for (let y = 0; y < g.h; y += 1) {
		for (let x = 0; x < g.w; x += 1) {
			const v = n(x, y) * 0.75 + m(x, y) * 0.25 + lush;
			g.set(x, y, groundAt(v));
		}
	}
};

const wood = (
	g: Grid,
	r: Rng,
	cx: number,
	cy: number,
	radius: number,
	keep: (x: number, y: number) => boolean
) => {
	const conifer = r.chance(0.5);

	for (let y = cy - radius - 1; y <= cy + radius + 1; y += 1) {
		for (let x = cx - radius - 1; x <= cx + radius + 1; x += 1) {
			if (!g.in(x, y) || keep(x, y)) {
				continue;
			}

			const d =
				Math.hypot(x - cx, (y - cy) * 1.3) / radius + (r.next() - 0.5) * 0.35;

			if (d < 0.45) {
				g.set(x, y, r.chance(0.6) ? "P" : "p");
			} else if (d < 0.8) {
				const thick = r.chance(0.6);
				const trees = conifer ? ["o", "O"] : ["i", "I"];
				g.set(x, y, (thick ? trees[0] : trees[1]) ?? "w");
			} else if (d < 1.1 && r.chance(0.6)) {
				g.set(x, y, r.pick(["W", "U", "w"]));
			}
		}
	}
};

const rocks = (
	g: Grid,
	r: Rng,
	cx: number,
	cy: number,
	keep: (x: number, y: number) => boolean
) => {
	if (!keep(cx, cy)) {
		g.set(cx, cy, "T");
	}

	for (let y = cy - 1; y <= cy + 1; y += 1) {
		for (let x = cx - 1; x <= cx + 1; x += 1) {
			if ((x !== cx || y !== cy) && !keep(x, y) && r.chance(0.45)) {
				g.set(x, y, r.pick(["t", "R", "r"]));
			}
		}
	}
};

const building = (
	g: Grid,
	r: Rng,
	x0: number,
	y0: number,
	w: number,
	h: number,
	doors: number,
	ruin: number
) => {
	for (let y = y0; y < y0 + h; y += 1) {
		for (let x = x0; x < x0 + w; x += 1) {
			const edge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;

			const corner =
				(x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);

			if (corner) {
				g.set(x, y, "k");
			} else if (edge) {
				g.set(x, y, r.chance(ruin) ? r.pick(["R", "L", "r"]) : "s");
			} else {
				g.set(x, y, r.chance(ruin * 0.4) ? "R" : r.pick(["c", "C", "C", "v"]));
			}
		}
	}

	for (let i = 0; i < doors; i += 1) {
		const side = r.int(0, 3);

		const across = side < 2;
		const x = across ? r.int(x0 + 1, x0 + w - 2) : doorEdge(side, x0, w);
		const y = across ? doorEdge(side + 2, y0, h) : r.int(y0 + 1, y0 + h - 2);

		g.set(x, y, "d");
	}
};

const doorEdge = (side: number, start: number, length: number) =>
	side === 2 ? start : start + length - 1;

const deployZone = (g: Grid, west: boolean, span = 3): Array<Sq> => {
	const squares: Array<Sq> = [];

	for (let i = 0; i < span; i += 1) {
		for (let y = 0; y < g.h; y += 1) {
			const x = west ? i : g.w - 1 - i;

			if (g.rules(x, y) !== "#" && g.get(x, y) !== " ") {
				squares.push({ x, y });
			}
		}
	}

	const mid = g.h / 2;

	return squares.toSorted(
		(a, b) =>
			Math.abs(a.y - mid) - Math.abs(b.y - mid) ||
			(west ? a.x - b.x : b.x - a.x)
	);
};

const connected = (g: Grid): boolean => {
	const seen = new Set<number>();
	const queue: Array<Sq> = [];

	for (let y = 0; y < g.h; y += 1) {
		if (g.rules(0, y) !== "#") {
			queue.push({ x: 0, y });
		}
	}

	for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
		const { x, y } = at;
		const k = y * g.w + x;

		if (seen.has(k) || !g.in(x, y) || g.rules(x, y) === "#") {
			continue;
		}

		seen.add(k);

		if (x === g.w - 1) {
			return true;
		}

		queue.push(
			{ x: x + 1, y },
			{ x: x - 1, y },
			{ x, y: y + 1 },
			{ x, y: y - 1 }
		);
	}

	return false;
};

type Words = readonly [string, ...ReadonlyArray<string>];

const NAMES: Readonly<Record<MapKind, readonly [Words, Words]>> = {
	crossing: [
		["Mill", "Heron", "Saltmarsh", "Drowned", "Old", "Weeping", "Kingsway"],
		["Crossing", "Ford", "Wade"],
	],
	keep: [
		["Broken", "Grey", "Thorn", "Ashen", "Lantern"],
		["Keep", "Hold", "Watch", "Bastion"],
	],
};

const named = (r: Rng, kind: MapKind) => {
	const [first, second] = NAMES[kind];

	return `The ${r.pick(first)} ${r.pick(second)}`;
};

const riverEdge = (r: Rng, i: number, width: number) => {
	if (i !== 0 && i !== width - 1) {
		return "X";
	}

	return r.chance(0.12) ? "x" : "Z";
};

const riverOf = (g: Grid, r: Rng) => {
	const { w, h } = g;
	const cells = new Set<number>();
	let rx = Math.round(w / 2) + r.int(-2, 2);

	for (let y = 0; y < h; y += 1) {
		if (r.chance(0.35)) {
			rx = Math.max(4, Math.min(w - 6, rx + r.pick([-1, 1])));
		}

		const width = r.chance(0.3) ? 3 : 2;

		for (let i = 0; i < width; i += 1) {
			g.set(rx + i, y, riverEdge(r, i, width));
			cells.add(y * w + rx + i);
		}

		for (const bank of [rx - 1, rx + width]) {
			if (r.chance(0.45)) {
				g.set(bank, y, "U");
			}
		}
	}

	return { cells, rx };
};

const roadOf = (g: Grid, r: Rng, river: ReadonlySet<number>) => {
	const { w, h } = g;
	const cells = new Set<number>();
	let ry = Math.round(h / 2) + r.int(-1, 1);

	for (let x = 0; x < w; x += 1) {
		if (x > 2 && x < w - 3 && r.chance(0.12)) {
			ry = Math.max(2, Math.min(h - 4, ry + r.pick([-1, 1])));
		}

		for (const y of [ry, ry + 1]) {
			g.set(x, y, river.has(y * w + x) ? "z" : "a");
			cells.add(y * w + x);
		}
	}

	return { cells, ry };
};

const crossing = (r: Rng, w: number, h: number): Grid => {
	const g = new Grid(w, h, "q");
	ground(g, r, 0);
	const { cells: river, rx } = riverOf(g, r);
	const { cells: road, ry } = roadOf(g, r, river);

	const busy = (x: number, y: number) =>
		road.has(y * w + x) || river.has(y * w + x) || x < 3 || x > w - 4;

	const bw = r.int(5, 7);
	const bh = r.int(4, 5);
	const north = r.chance(0.5);
	const east = r.chance(0.5);
	const bx = east ? Math.min(w - 4 - bw, rx + 4) : Math.max(3, rx - 3 - bw);
	const by = north ? Math.max(0, ry - 1 - bh) : Math.min(h - bh, ry + 3);
	building(g, r, bx, by, bw, bh, 2, 0.3);

	const inRuin = (x: number, y: number) =>
		x >= bx && x < bx + bw && y >= by && y < by + bh;

	const keep = (x: number, y: number) => busy(x, y) || inRuin(x, y);

	for (let i = r.int(2, 3); i > 0; i -= 1) {
		wood(
			g,
			r,
			r.int(3, w - 4),
			r.chance(0.5) ? r.int(0, ry - 2) : r.int(ry + 3, h - 1),
			r.int(2, 3),
			keep
		);
	}

	for (let i = r.int(2, 4); i > 0; i -= 1) {
		rocks(g, r, r.int(3, w - 4), r.int(0, h - 1), keep);
	}

	return g;
};

interface Walls {
	readonly x0: number;
	readonly y0: number;
	readonly x1: number;
	readonly y1: number;
}

const courtyard = (g: Grid, r: Rng, { x0, y0, x1, y1 }: Walls) => {
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const edge = x === x0 || x === x1 || y === y0 || y === y1;

			if (edge) {
				g.set(x, y, "s");
			} else {
				g.set(
					x,
					y,
					r.chance(0.7) ? r.pick(["C", "C", "c"]) : r.pick(["u", "Q", "q"])
				);
			}
		}
	}

	for (const [x, y] of [
		[x0, y0],
		[x1, y0],
		[x0, y1],
		[x1, y1],
	] as const) {
		for (let dy = -1; dy <= 1; dy += 1) {
			for (let dx = -1; dx <= 1; dx += 1) {
				g.set(x + dx, y + dy, dx === 0 && dy === 0 ? "K" : "k");
			}
		}
	}
};

const OPEN_GROUND = new Set(["C", "c", "u", "Q", "q"]);

const spotIn = (g: Grid, r: Rng, { x0, y0, x1, y1 }: Walls) => {
	const free = (x: number, y: number) => OPEN_GROUND.has(g.get(x, y));

	let found: Sq | undefined;

	for (let i = 0; i < 50 && found === undefined; i += 1) {
		const x = r.int(x0 + 2, x1 - 2);
		const y = r.int(y0 + 2, y1 - 2);

		if (free(x, y) && free(x + 1, y) && free(x, y + 1)) {
			found = { x, y };
		}
	}

	return found;
};

const keepOf = (r: Rng, w: number, h: number): Grid => {
	const g = new Grid(w, h, "q");
	ground(g, r, 0.1);
	const walls: Walls = { x0: 4, y0: 1, x1: w - 5, y1: h - 2 };
	const { x0, y0, x1, y1 } = walls;
	courtyard(g, r, walls);

	const gate = Math.round((y0 + y1) / 2);
	g.set(x0, gate, "d");
	g.set(x0, gate + 1, "d");

	for (let x = 0; x < x0; x += 1) {
		g.set(x, gate, "a");
		g.set(x, gate + 1, "a");
	}

	const breach = r.int(y0 + 2, y1 - 3);

	for (let dy = 0; dy < 3; dy += 1) {
		g.set(x1, breach + dy, r.pick(["R", "R", "L"]));
		g.set(x1 + 1, breach + dy, r.pick(["r", "R", "t"]));
	}

	const hw = r.int(5, 7);
	const hh = r.int(3, 4);
	const hx = r.int(x0 + 3, x1 - hw - 2);
	const hy = r.chance(0.5) ? y0 + 2 : y1 - hh - 1;
	building(g, r, hx, hy, hw, hh, 2, 0);

	for (let x = hx + 1; x < hx + hw - 1; x += 1) {
		g.set(x, hy + (hy === y0 + 2 ? 0 : hh - 1), "f");
	}

	const spot = () => spotIn(g, r, walls);

	const well = spot();

	if (well) {
		g.set(well.x, well.y, "F");
	}

	const statue = spot();

	if (statue) {
		g.set(statue.x, statue.y, "J");
	}

	for (let i = r.int(3, 6); i > 0; i -= 1) {
		const s = spot();

		if (s) {
			g.set(s.x, s.y, r.pick(["R", "r", "L"]));
		}
	}

	const outside = (x: number, y: number) =>
		(x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1) ||
		x < 2 ||
		x > w - 3;

	for (let i = r.int(1, 2); i > 0; i -= 1) {
		wood(g, r, r.pick([1, w - 2]), r.int(0, h - 1), 2, outside);
	}

	return g;
};

export const generateMap = (
	kind: MapKind,
	seed: number,
	w = 24,
	h = 14
): GeneratedMap => {
	const r = rng(seed);

	for (let attempt = 0; attempt < 20; attempt += 1) {
		const g = kind === "crossing" ? crossing(r, w, h) : keepOf(r, w, h);

		if (!connected(g)) {
			continue;
		}

		return {
			name: named(r, kind),
			lines: g.lines(),
			deploy: { west: deployZone(g, true), east: deployZone(g, false) },
		};
	}

	throw new Error(
		`no ${kind} for seed ${seed} could be crossed from west to east`
	);
};

export const mapFileText = (m: GeneratedMap): string =>
	`${[`name: ${m.name}`, "style: mekmode", ...m.lines].join("\n")}\n`;
