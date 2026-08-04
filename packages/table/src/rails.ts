import type { TableLayout } from "./index.js";

export const SIDEBAR_WIDTH = 28;
export const MAP_FOCUSED_FEED_WIDTH = 26;
export const MINIMUM_FEED_PANE_WIDTH = 12;
export const MINIMUM_MAP_PANE_WIDTH = 18;
export const FEED_FOCUSED_FEED_RATIO = 0.42;
export const MAIN_PANE_GUTTERS = 2;
export const PANE_HORIZONTAL_BORDER_CELLS = 2;
export const MESSAGE_PANE_ROWS = 3;
export const MAP_STATUS_ROWS = 1;
export const PANE_TITLE_END_CELLS = 4;
export const RAIL_WIDTH = 5;
export const RAIL_INTERIOR_WIDTH = RAIL_WIDTH - PANE_HORIZONTAL_BORDER_CELLS;

const HEADER_ROWS = 1;
const STATUS_ROWS = 1;
const KEYBIND_BAR_ROWS = 1;
const MINIMUM_RAIL_INTERIOR_ROWS = 1;
const MINIMUM_MAIN_ROWS = MINIMUM_RAIL_INTERIOR_ROWS + 2;
const NO_MAP_PANE_GUTTERS = 1;

/** ADR-0030's ordered demotion ladder. No-op stages remain explicit so later
 * tickets extend this engine instead of growing a second fit policy. */
export const TABLE_DEMOTION_STAGES = [
	{
		id: "compact-keybar",
		implemented: false,
		note: "#119 owns the keybar 5→3 demotion",
	},
	{
		id: "compact-sidebar-rows",
		implemented: false,
		note: "named, not yet live: no shipped Panel emits two-line rows; the first must add a real likely height-based trigger here",
	},
	{
		id: "readable-pane-minima",
		implemented: true,
		note: "expanded panes shrink to their declared readable minima",
	},
	{
		id: "preset-forced-rails",
		implemented: true,
		note: "temporary Rails follow the preset-specific order",
	},
	{
		id: "map-viewport-floor",
		implemented: false,
		note: "#117 owns module-declared Map floors and one-way snap-down",
	},
	{
		id: "terminal-too-small",
		implemented: true,
		note: "no-map fails honestly rather than erasing a required region",
	},
] as const;

export interface RailPreferences {
	readonly feedRail?: boolean;
	readonly sidebarRail?: boolean;
}

export interface TableFit {
	readonly feedRail: boolean;
	readonly forcedFeedRail: boolean;
	readonly forcedSidebarRail: boolean;
	readonly sidebarRail: boolean;
	readonly tooSmall: boolean;
}

const mapLayoutMinimumWidth = (
	feedRail: boolean,
	sidebarRail: boolean
): number =>
	(feedRail ? RAIL_WIDTH : MINIMUM_FEED_PANE_WIDTH) +
	MINIMUM_MAP_PANE_WIDTH +
	(sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH) +
	MAIN_PANE_GUTTERS;

const noMapMinimumWidth = (sidebarRail: boolean): number =>
	MINIMUM_FEED_PANE_WIDTH +
	(sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH) +
	NO_MAP_PANE_GUTTERS;

const minimumTableHeight = (): number =>
	HEADER_ROWS +
	MINIMUM_MAIN_ROWS +
	STATUS_ROWS +
	MESSAGE_PANE_ROWS +
	KEYBIND_BAR_ROWS;

/** Pure fit policy: explicit preferences enter unchanged; forced Rails are a
 * separate overlay and therefore disappear as soon as the terminal grows. */
export const resolveTableFit = (
	terminal: { readonly width: number; readonly height: number },
	layout: TableLayout,
	explicit: RailPreferences = {}
): TableFit => {
	const explicitFeedRail = explicit.feedRail ?? false;
	const explicitSidebarRail = explicit.sidebarRail ?? false;
	let forcedFeedRail = false;
	let forcedSidebarRail = false;

	if (layout === "map-focused") {
		if (
			!explicitFeedRail &&
			mapLayoutMinimumWidth(false, explicitSidebarRail) > terminal.width
		) {
			forcedFeedRail = true;
		}
		if (
			!explicitSidebarRail &&
			mapLayoutMinimumWidth(explicitFeedRail || forcedFeedRail, false) >
				terminal.width
		) {
			forcedSidebarRail = true;
		}
	} else if (
		!explicitSidebarRail &&
		(layout === "no-map"
			? noMapMinimumWidth(false)
			: mapLayoutMinimumWidth(explicitFeedRail, false)) > terminal.width
	) {
		forcedSidebarRail = true;
	}

	const feedRail = explicitFeedRail || forcedFeedRail;
	const sidebarRail = explicitSidebarRail || forcedSidebarRail;
	return {
		feedRail,
		forcedFeedRail,
		forcedSidebarRail,
		sidebarRail,
		tooSmall:
			terminal.height < minimumTableHeight() ||
			(layout === "no-map" && noMapMinimumWidth(sidebarRail) > terminal.width),
	};
};

const summary = (count: number): string => `+${Math.max(0, count)}`;

/** Three-cell Feed Rail body, top-down. `●` is the printing activity mark. */
export const formatFeedRail = (
	newWhileRailed: number,
	interiorRows: number
): readonly string[] => {
	const lines = ["[+]"];
	if (newWhileRailed > 0) {
		lines.push(" ● ", newWhileRailed > 99 ? "99+" : String(newWhileRailed));
	}
	return lines.slice(0, Math.max(0, interiorRows));
};

export interface SidebarRailSeat {
	readonly actor: string | null;
}

/** Three-cell Sidebar Rail body. Presence means claimed/unclaimed here; the
 * expanded Seat list deliberately retains its viewer-relative marker. */
export const formatSidebarRail = (
	seats: readonly SidebarRailSeat[],
	interiorRows: number,
	spectatorCount?: number
): readonly string[] => {
	if (interiorRows <= 0) {
		return [];
	}
	const hasSpectators = spectatorCount !== undefined && spectatorCount > 0;
	const bodyRows = interiorRows - 1;
	const spectatorRows = hasSpectators ? 1 : 0;
	let visibleSeats = Math.min(
		seats.length,
		Math.max(0, bodyRows - spectatorRows)
	);
	let overflow = seats.length - visibleSeats;
	if (overflow > 0 && visibleSeats > 0) {
		visibleSeats -= 1;
		overflow += 1;
	}
	const lines = [
		"[+]",
		...seats
			.slice(0, visibleSeats)
			.map((seat) => (seat.actor === null ? " ○ " : " ● ")),
	];
	if (hasSpectators) {
		lines.push(summary(spectatorCount));
	}
	if (overflow > 0 && lines.length < interiorRows) {
		lines.push(summary(overflow));
	}
	return lines.slice(0, interiorRows);
};
