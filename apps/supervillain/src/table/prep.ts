import { charsOf, formatSquare, ifDefined } from "@supervillain/domain";

import type { MapView, PrepFigure, PrepItem, PrepView } from "./view.ts";

export const PREP_WIDTH = { least: 26, most: 34 } as const;

export const prepWidth = (cols: number): number =>
	Math.min(PREP_WIDTH.most, Math.max(PREP_WIDTH.least, Math.floor(cols / 3)));

export type PrepArmed =
	| { readonly kind: "token"; readonly id: string }
	| { readonly kind: "count"; readonly line: string; readonly n: number };

export type PrepNext =
	| {
			readonly kind: "place";
			readonly id: string;
			readonly name: string;
			readonly figure: PrepFigure;
	  }
	| {
			readonly kind: "add";
			readonly name: string;
			readonly figure: PrepFigure;
			readonly n: number;
			readonly line: string;
	  };

export const countLine = (item: PrepItem, n: number): string =>
	n <= 1 ? item.line : `${item.line} x${n}`;

const items = (view: PrepView): ReadonlyArray<PrepItem> =>
	view.sections.flatMap((s) => s.items);

export const prepNext = (
	view: PrepView,
	armed: PrepArmed | undefined
): PrepNext | undefined => {
	if (armed?.kind === "count") {
		const item = items(view).find(
			(i) => i.kind === "count" && i.line === armed.line
		);

		if (item?.figure !== undefined) {
			return {
				kind: "add",
				name: item.label,
				figure: item.figure,
				n: armed.n,
				line: countLine(item, armed.n),
			};
		}
	}

	if (armed?.kind === "token") {
		const waiting = view.place.find((t) => t.id === armed.id);

		if (waiting !== undefined) {
			return { kind: "place", ...waiting };
		}

		const joining = items(view).find(
			(i) => i.kind === "send" && i.figure?.id === armed.id
		);

		if (joining?.figure !== undefined) {
			return {
				kind: "place",
				id: armed.id,
				name: joining.label,
				figure: joining.figure,
			};
		}
	}

	const [first] = view.place;

	return first === undefined ? undefined : { kind: "place", ...first };
};

export const armedStands = (view: PrepView, armed: PrepArmed): boolean => {
	const next = prepNext(view, armed);

	return armed.kind === "count"
		? next?.kind === "add"
		: next?.kind === "place" && next.id === armed.id;
};

export const prepCount = (
	armed: PrepArmed | undefined,
	item: PrepItem,
	by: 1 | -1
): PrepArmed | undefined => {
	if (item.kind !== "count") {
		return armed;
	}

	const same = armed?.kind === "count" && armed.line === item.line;

	const n = Math.min(
		item.max ?? Number.POSITIVE_INFINITY,
		(same ? armed.n : 0) + by
	);

	return n <= 0 ? undefined : { kind: "count", line: item.line, n };
};

interface Square {
	readonly x: number;
	readonly y: number;
}

const free = (map: MapView): Array<Square> => {
	const taken = new Set(
		map.tokens.filter((t) => !t.dead).map((t) => `${t.x},${t.y}`)
	);

	const out: Array<Square> = [];

	for (const [y, row] of map.terrain.entries()) {
		for (const [x, t] of charsOf(row).entries()) {
			if ((t === "." || t === "~") && !taken.has(`${x},${y}`)) {
				out.push({ x, y });
			}
		}
	}

	return out;
};

export const placeNear = (
	map: MapView,
	ids: ReadonlyArray<string>,
	at: Square
): Array<string> => {
	const d = (s: Square) => (s.x - at.x) ** 2 + (s.y - at.y) ** 2;

	const squares = free(map).toSorted(
		(a, b) => d(a) - d(b) || a.y - b.y || a.x - b.x
	);

	return ids.flatMap((id, i) => {
		const s = squares[i];

		return s === undefined ? [] : [`/place ${id} ${formatSquare(s)}`];
	});
};

export const prepHints = (
	next: PrepNext | undefined,
	key: number
): ReadonlyArray<string> => {
	const hide = `Alt+${key} hides it`;

	if (next === undefined) {
		return [
			`click to send · Up shows what was sent · ${hide} · /help`,
			`click to send · ${hide}`,
			hide,
			"",
		];
	}

	const typed =
		next.kind === "place"
			? `/place ${next.id} <square>`
			: `${next.line} then /place`;

	const does =
		next.kind === "place"
			? `a square places ${next.name}`
			: `a square adds them there`;

	return [
		`${does} · ${typed} · Esc puts it down · ${hide}`,
		`${does} · ${typed}`,
		typed,
		"",
	];
};

const QUADRANTS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";

export const figureText = (glyph: string | undefined): [string, string] => {
	const lit = (x: number, y: number) => {
		const pair = glyph?.slice(y * 2, y * 2 + 2) ?? "";
		const byte = Number.parseInt(pair === "" ? "00" : pair, 16);

		return Math.floor(byte / 2 ** (7 - x)) % 2 === 1;
	};

	const quarter = (x: number, qy: number) => {
		let n = 0;

		for (let y = qy * 3; y < qy * 3 + 3; y += 1) {
			n += +lit(x, y);
		}

		return n >= 2;
	};

	const row = (r: number) =>
		Array.from({ length: 4 }, (_, c) => {
			const bits =
				+quarter(c * 2, r * 2) +
				2 * +quarter(c * 2 + 1, r * 2) +
				4 * +quarter(c * 2, r * 2 + 1) +
				8 * +quarter(c * 2 + 1, r * 2 + 1);

			return QUADRANTS.at(bits) ?? " ";
		}).join("");

	return [row(0), row(1)];
};

export interface StageEntry {
	readonly key: string;
	readonly name: string;
	readonly tier?: "on-table" | "in-codex";
	readonly items: ReadonlyArray<PrepItem>;
}

const CARD_LINE = /^\/(?:show|reveal|hide) (?<key>\S+)$/u;

const FIRST_WORD = /^(?<word>\S+)\s+(?<rest>.*)$/u;

const tierOf = (note: string | undefined): StageEntry["tier"] => {
	if (note === "on the table") {
		return "on-table";
	}

	return note === "in the codex" ? "in-codex" : undefined;
};

const entryName = (item: PrepItem): string =>
	FIRST_WORD.exec(item.label)?.groups?.rest ?? item.label;

export const stageEntries = (
	listed: ReadonlyArray<PrepItem>
): ReadonlyArray<StageEntry> => {
	const entries: Array<StageEntry> = [];

	for (const item of listed) {
		const key = CARD_LINE.exec(item.line)?.groups?.key;
		const last = entries.at(-1);

		if (key !== undefined && last?.key === key) {
			const tier = last.tier ?? tierOf(item.note);
			entries[entries.length - 1] = {
				...last,
				...ifDefined(tier, (value) => ({ tier: value })),
				items: [...last.items, item],
			};
		} else if (
			key === undefined &&
			item.lines !== undefined &&
			last !== undefined
		) {
			entries[entries.length - 1] = { ...last, items: [...last.items, item] };
		} else {
			const tier = tierOf(item.note);
			entries.push({
				key: key ?? item.line,
				name: entryName(item),
				...ifDefined(tier, (value) => ({ tier: value })),
				items: [item],
			});
		}
	}

	return entries;
};

export const chipLabel = (item: PrepItem): string => {
	if (item.lines !== undefined) {
		return "▶ fight";
	}

	return FIRST_WORD.exec(item.label)?.groups?.word ?? item.label;
};

export const chipRows = (
	labels: ReadonlyArray<string>,
	width: number
): ReadonlyArray<ReadonlyArray<number>> => {
	const rows: Array<Array<number>> = [];
	let used = 0;

	for (const [i, label] of labels.entries()) {
		const w = Bun.stringWidth(label) + 3;
		const row = rows.at(-1);

		if (row === undefined || used + w > width) {
			rows.push([i]);
			used = w;
		} else {
			row.push(i);
			used += w;
		}
	}

	return rows;
};
