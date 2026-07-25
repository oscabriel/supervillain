/**
 * The battle map's view model: everything about the chrome map region that is
 * arithmetic rather than drawing. The region is core chrome's own — never a
 * layout slot, which places *module* panels — so this file is pure core-side
 * composition with no game import anywhere near it.
 *
 * One map cell is one terminal cell, NetHack-style; the resulting ~1:2 aspect
 * distortion is accepted by ADR-0006 and deliberately not corrected here.
 * Colors are the five exact-ANSI-16 theme tokens and nothing else — the map
 * introduces no second color contract.
 */
import {
	isInsideMap,
	mapDimensions,
	mapGlyphAt,
	mapTileAt,
	tokenAt,
} from "@supervillain/core";
import type {
	BattleMap,
	FeedLine,
	MapTile,
	MapToken,
	ThemeToken,
} from "@supervillain/core";

/** One composed terminal cell: the glyph plus the two tokens it wears. */
export interface MapCell {
	readonly glyph: string;
	readonly fg: ThemeToken;
	readonly bg: ThemeToken;
}

/** The window of the map the region currently shows. */
export interface MapViewport {
	readonly originX: number;
	readonly originY: number;
	readonly width: number;
	readonly height: number;
}

export interface MapCursor {
	readonly x: number;
	readonly y: number;
}

interface TileStyle {
	readonly fg: ThemeToken;
	readonly bg: ThemeToken;
}

/** Terrain as background plus the author's own glyph in the foreground. The
 * legend carries the semantics; this table is the only place they become
 * color, and it spends nothing outside the five theme tokens. */
const TILE_STYLE: Readonly<Record<MapTile, TileStyle>> = {
	difficult: { bg: "muted", fg: "success" },
	door: { bg: "muted", fg: "accent" },
	floor: { bg: "muted", fg: "primary" },
	hazard: { bg: "muted", fg: "danger" },
	wall: { bg: "primary", fg: "muted" },
};

/** The style an unlegended character falls back to. Validation makes this
 * unreachable for a map that came through `parseMapFile`; a fold that ever
 * meets one still draws something rather than nothing. */
const UNKNOWN_TILE_STYLE: TileStyle = { bg: "muted", fg: "muted" };

const CURSOR_STYLE: TileStyle = { bg: "accent", fg: "primary" };
const SELECTED_STYLE: TileStyle = { bg: "success", fg: "primary" };

/** A token bound to the seat you hold reads differently from everyone else's —
 * the same seat binding the authority check uses, shown rather than explained. */
const OWN_TOKEN_FG: ThemeToken = "success";
const OTHER_TOKEN_FG: ThemeToken = "accent";

/** Cursor steps, arrow keys and vi keys alike. Keyboard-first everywhere. */
const CURSOR_STEPS: Readonly<Record<string, readonly [number, number]>> = {
	down: [0, 1],
	h: [-1, 0],
	j: [0, 1],
	k: [0, -1],
	l: [1, 0],
	left: [-1, 0],
	right: [1, 0],
	up: [0, -1],
};

const clamp = (value: number, limit: number): number =>
	Math.max(0, Math.min(value, limit));

/** The cursor a movement key lands on, or `null` when the key moves nothing. */
export const moveMapCursor = (
	map: BattleMap,
	cursor: MapCursor,
	keyName: string
): MapCursor | null => {
	const step = CURSOR_STEPS[keyName];
	if (step === undefined) {
		return null;
	}
	const { height, width } = mapDimensions(map);
	const next = {
		x: clamp(cursor.x + step[0], width - 1),
		y: clamp(cursor.y + step[1], height - 1),
	};
	return next.x === cursor.x && next.y === cursor.y ? null : next;
};

/** Slides the window the least distance that keeps the cursor inside it, then
 * clamps it to the map. Panning is a consequence of moving, never a mode; with
 * no cursor the window only re-clamps. */
export const scrollViewport = (
	map: BattleMap,
	size: { readonly width: number; readonly height: number },
	origin: { readonly originX: number; readonly originY: number },
	cursor: MapCursor | null
): MapViewport => {
	const { height, width } = mapDimensions(map);
	const follow = (
		start: number,
		extent: number,
		position: number | undefined,
		limit: number
	): number =>
		clamp(
			position === undefined
				? start
				: Math.min(Math.max(start, position - extent + 1), position),
			Math.max(0, limit - extent)
		);
	return {
		height: size.height,
		originX: follow(origin.originX, size.width, cursor?.x, width),
		originY: follow(origin.originY, size.height, cursor?.y, height),
		width: size.width,
	};
};

export interface MapComposition {
	readonly map: BattleMap;
	readonly tokens: readonly MapToken[];
	readonly viewport: MapViewport;
	/** The keyboard cursor, or `null` while the region is not focused. */
	readonly cursor: MapCursor | null;
	readonly selectedTokenId: string | null;
	/** The seat the viewer holds, so their own tokens read differently. */
	readonly ownSeatId: string | null;
}

const tokenStyle = (
	token: MapToken,
	terrain: TileStyle,
	ownSeatId: string | null
): TileStyle => ({
	bg: terrain.bg,
	fg:
		token.seatId !== null && token.seatId === ownSeatId
			? OWN_TOKEN_FG
			: OTHER_TOKEN_FG,
});

/**
 * Composes the visible window into rows of cells. `null` is a cell the map
 * does not have — the region is larger than the grid there and draws nothing.
 */
export const composeMapCells = (
	composition: MapComposition
): readonly (readonly (MapCell | null)[])[] => {
	const { cursor, map, ownSeatId, selectedTokenId, tokens, viewport } =
		composition;
	const rows: (MapCell | null)[][] = [];
	for (let row = 0; row < viewport.height; row += 1) {
		const y = viewport.originY + row;
		const cells: (MapCell | null)[] = [];
		for (let column = 0; column < viewport.width; column += 1) {
			const x = viewport.originX + column;
			const glyph = isInsideMap(map, x, y) ? mapGlyphAt(map, x, y) : null;
			if (glyph === null) {
				cells.push(null);
				continue;
			}
			const tile = mapTileAt(map, x, y);
			const terrain = tile === null ? UNKNOWN_TILE_STYLE : TILE_STYLE[tile];
			const token = tokenAt(tokens, x, y);
			const base =
				token === null
					? { ...terrain, glyph }
					: { ...tokenStyle(token, terrain, ownSeatId), glyph: token.glyph };
			if (cursor !== null && cursor.x === x && cursor.y === y) {
				cells.push({ ...CURSOR_STYLE, glyph: base.glyph });
				continue;
			}
			if (token !== null && token.id === selectedTokenId) {
				cells.push({ ...SELECTED_STYLE, glyph: base.glyph });
				continue;
			}
			cells.push(base);
		}
		rows.push(cells);
	}
	return rows;
};

/**
 * Hit-testing, by coordinate arithmetic and nothing else: a cell offset inside
 * the region becomes the map cell under it, or `null` off the grid.
 */
export const mapCellAt = (
	map: BattleMap,
	viewport: MapViewport,
	column: number,
	row: number
): MapCursor | null => {
	if (
		column < 0 ||
		row < 0 ||
		column >= viewport.width ||
		row >= viewport.height
	) {
		return null;
	}
	const cell = {
		x: viewport.originX + column,
		y: viewport.originY + row,
	};
	return isInsideMap(map, cell.x, cell.y) ? cell : null;
};

/** The region's one-line header: what is loaded and how big it is. */
export const mapTitleLine = (map: BattleMap): FeedLine => {
	const { height, width } = mapDimensions(map);
	return {
		runs: [
			{ text: `map · ${map.name} `, token: "accent" },
			{ text: `${width}×${height}`, token: "muted" },
		],
	};
};

/** The region's status line: where the cursor is, what it is standing on, and
 * what is selected. The keyboard surface explains itself here. */
export const mapStatusLine = (
	composition: Pick<
		MapComposition,
		"cursor" | "map" | "selectedTokenId" | "tokens"
	>
): FeedLine => {
	const { cursor, map, selectedTokenId, tokens } = composition;
	if (cursor === null) {
		const count = `${tokens.length} token${tokens.length === 1 ? "" : "s"}`;
		return {
			runs: [{ text: `${count} · Tab to take the map`, token: "muted" }],
		};
	}
	const tile = mapTileAt(map, cursor.x, cursor.y) ?? "unknown";
	const under = tokenAt(tokens, cursor.x, cursor.y);
	const selected = tokens.find((token) => token.id === selectedTokenId);
	const runs = [
		{ text: `${cursor.x},${cursor.y} `, token: "accent" as ThemeToken },
		{ text: tile, token: "muted" as ThemeToken },
	];
	if (under !== null) {
		runs.push({
			text: ` · ${under.glyph} ${under.label === "" ? under.id : under.label}`,
			token: "primary",
		});
	}
	if (selected !== undefined) {
		runs.push({
			text: ` · holding ${selected.glyph} — Enter to drop`,
			token: "success",
		});
	}
	return { runs };
};
