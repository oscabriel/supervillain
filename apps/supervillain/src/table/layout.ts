import { bandLayout } from "./band.ts";
import type { Panels } from "./panels.ts";
import type { CombatView } from "./view.ts";

export const BAND_FRAME = { width: 4, height: 2 } as const;

export const FIXED_ROWS = 3;

export const FEED_MIN = 5;

export const BAND_MIN = 3;

export const PANE_MIN = 8;

export const MAP_MIN = 8;

export const MAP_FLOOR = 5;

export const BAND_FOLDED = 4;

export interface Screen {
	readonly width: number;
	readonly height: number;
	readonly knocks: boolean;
	readonly menuRows: number;
	readonly fighting: boolean;
}

export interface Room {
	readonly room: number;
	readonly cap: number;
}

export interface BandWant {
	readonly wanted: number;
	readonly keep: number;
}

export interface Heights {
	readonly band: number;
	readonly pane: number;
	readonly map: number;
}

const drawn = (rows: number) => (rows < MAP_FLOOR ? 0 : rows);

export const roomFor = (
	screen: Screen,
	shown: Panels,
	withNotice: boolean
): Room => {
	const h = screen.height;

	const room =
		h -
		FIXED_ROWS -
		(screen.knocks ? 1 : 0) -
		(shown.feed ? FEED_MIN : 0) -
		(withNotice ? 1 : 0) -
		screen.menuRows;

	const cap = shown.feed
		? Math.floor(screen.fighting ? (h * 2) / 3 : h / 2)
		: room;

	return { room, cap };
};

export const bandRows = (
	combat: CombatView | undefined,
	width: number,
	cap: number
): BandWant => {
	if (combat === undefined) {
		return { wanted: BAND_MIN, keep: BAND_MIN };
	}

	const layout = bandLayout(
		combat,
		width - BAND_FRAME.width,
		cap - BAND_FRAME.height
	);

	const wanted = Math.max(BAND_MIN, layout.lines.length + BAND_FRAME.height);

	return {
		wanted,
		keep: Math.min(
			wanted,
			Math.max(BAND_MIN, layout.livingLines + BAND_FRAME.height)
		),
	};
};

export const mapHeights = (
	wanted: number,
	band: BandWant,
	room: number,
	shown: Panels
): Omit<Heights, "pane"> => {
	if (!shown.band) {
		return { band: 0, map: drawn(Math.min(wanted, room)) };
	}

	if (shown.mapFirst) {
		const folded = Math.min(band.wanted, BAND_FOLDED);
		const mapH = Math.min(wanted, room - folded);

		return { band: Math.max(folded, room - mapH), map: drawn(mapH) };
	}

	const share = Math.min(wanted, Math.max(MAP_MIN, Math.floor(room / 2)));

	const bandH = Math.min(
		room,
		Math.max(band.keep, Math.min(band.wanted, room - share))
	);

	return { band: bandH, map: drawn(Math.min(wanted, room - bandH)) };
};

export interface HeightsInput {
	readonly screen: Screen;
	readonly shown: Panels;
	readonly combat: CombatView | undefined;
	readonly noticeLine: boolean;
	readonly paneOpen: boolean;
	readonly paneRows: number;
	readonly small: boolean;
	readonly mapWanted: number | undefined;
	readonly party?: BandWant;
}

const paneWantedOf = (input: HeightsInput, room: number): number => {
	if (!input.paneOpen) {
		return 0;
	}

	const h = input.screen.height;

	const most = input.shown.feed
		? Math.min(Math.floor(h / 2), room - (input.shown.band ? BAND_MIN : 0))
		: room;

	return Math.max(3, Math.min(input.paneRows + 2, most));
};

export const heights = (input: HeightsInput): Heights => {
	const { screen, shown, combat } = input;
	const h = screen.height;
	const { room, cap } = roomFor(screen, shown, input.noticeLine);
	const paneWanted = paneWantedOf(input, room);

	if (input.small) {
		return {
			band: 0,
			pane: input.paneOpen ? Math.max(3, Math.min(paneWanted, room)) : 0,
			map: 0,
		};
	}

	if (input.mapWanted !== undefined) {
		const band = input.party ?? bandRows(combat, screen.width, cap);

		return { ...mapHeights(input.mapWanted, band, room, shown), pane: 0 };
	}

	if (!shown.band) {
		return {
			band: 0,
			pane: input.paneOpen ? Math.min(paneWanted, room) : 0,
			map: 0,
		};
	}

	if (input.party !== undefined) {
		const band = Math.max(
			BAND_MIN,
			Math.min(input.party.wanted, cap, room - paneWanted)
		);

		return { band, pane: paneWanted, map: 0 };
	}

	if (combat === undefined || !combat.active) {
		const band = Math.max(BAND_MIN, Math.min(cap, room - paneWanted));

		return { band, pane: paneWanted, map: 0 };
	}

	const layout = bandLayout(
		combat,
		screen.width - BAND_FRAME.width,
		cap - BAND_FRAME.height,
		{ heroesWhole: input.paneOpen }
	);

	const wanted = layout.lines.length + BAND_FRAME.height;

	if (!input.paneOpen) {
		return {
			band: Math.max(BAND_MIN, Math.min(wanted, room)),
			pane: 0,
			map: 0,
		};
	}

	const paneMin = Math.min(paneWanted, Math.max(PANE_MIN, Math.floor(h / 3)));
	const keep = Math.min(layout.keepLines + BAND_FRAME.height, room - 3);
	const band = Math.max(BAND_MIN, keep, Math.min(wanted, room - paneMin));

	return {
		band,
		pane: Math.max(3, Math.min(paneWanted, room - band)),
		map: 0,
	};
};
