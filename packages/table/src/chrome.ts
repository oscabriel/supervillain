/* oxlint-disable promise/prefer-await-to-then -- panel dispatch is synchronously fire-and-forget and the pinned contract requires a rejection catch. */
import {
	BoxRenderable,
	CliRenderEvents,
	InputRenderable,
	InputRenderableEvents,
	RGBA,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from "@opentui/core";
import type {
	CliRenderer,
	KeyEvent,
	TextChunk,
} from "@opentui/core";
import type {
	CoreCommand,
	Envelope,
	FeedLine,
	GamePanel,
	GamePanelInput,
	MessageTask,
	PanelKey,
	RoomSubmission,
	TableView,
	ViewEntry,
} from "@supervillain/core";

import { readTableCheckpoint } from "./checkpoint.js";
import { createTableFold } from "./fold.js";
import type {
	TableLayout,
	TableOptions,
	TablePreferenceChange,
} from "./index.js";
import { parseInput } from "./input.js";
import type { ParsedInput } from "./input.js";
import { deriveKeybindBar, deriveKeySheet, formatBinding } from "./keymap.js";
import type { KeybindBar, TablePane } from "./keymap.js";
import { mapCommandFor, mapKeyAction } from "./map-interaction.js";
import type { MapInteraction } from "./map-interaction.js";
import { bitmapSupportedFor, rawWriteChannelFor } from "./map-kitty-channel.js";
import type { Framebuffer, PlaceholderLayout } from "./map-kitty.js";
import { KittyMapSurface } from "./map-kitty.js";
import {
	MapSurfaceRenderable,
	mapRegionSize,
	mapViewportCellRows,
} from "./map-region.js";
import type { MapRenderMode } from "./map-region.js";
import { mapStatusLine } from "./map.js";
import type { MapCursor, MapSize } from "./map.js";
import {
	FEED_FOCUSED_FEED_RATIO,
	formatFeedRail,
	formatSidebarRail,
	MAIN_PANE_GUTTERS,
	MAP_FOCUSED_FEED_WIDTH,
	MAP_STATUS_ROWS,
	MESSAGE_PANE_ROWS,
	MINIMUM_FEED_PANE_WIDTH,
	MINIMUM_MAP_PANE_WIDTH,
	PANE_HORIZONTAL_BORDER_CELLS,
	PANE_TITLE_END_CELLS,
	RAIL_WIDTH,
	resolveTableFit,
	SIDEBAR_WIDTH,
} from "./rails.js";
import type { TableFit } from "./rails.js";
import { resolveTextAttributes, resolveThemeToken } from "./theme.js";

const COLLAPSE_MARK = "[−]";
const TITLE_GRAPHEMES = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});
const displayWidth = (
	globalThis as typeof globalThis & {
		readonly Bun: { readonly stringWidth: (text: string) => number };
	}
).Bun.stringWidth;

const explicitRailPreferences = (options: TableOptions) => ({
	feedRail: options.viewOptions?.feedRail ?? false,
	sidebarRail: options.viewOptions?.sidebarRail ?? false,
});

/** Everything the bitmap frame hook touches, resolved at call time. */
interface BitmapEmission {
	channel: KittyMapSurface | null;
	blocked: () => boolean;
}

/**
 * Builds the surface's frame hook: rasterized frames go to the emitter only
 * when the session is live and the channel exists, and the emitter's
 * placeholder layout flows back for the region to spell into its cells.
 * Occlusion needs no wiring at all — placeholders are ordinary text, so
 * chrome over the map (key sheet, dialogs) rides OpenTUI's own z-order.
 */
const wireBitmapHook = (
	emission: BitmapEmission,
	markActive: () => void
): ((frame: Framebuffer, grid: MapSize) => PlaceholderLayout | null) =>
	(frame, grid) => {
		if (emission.channel === null || emission.blocked()) {
			return null;
		}
		const layout = emission.channel.render(frame, grid);
		if (layout !== null) {
			markActive();
		}
		return layout;
	};

const createBitmapChannel = (renderer: CliRenderer): KittyMapSurface | null =>
	bitmapSupportedFor(renderer, process.env)
		? new KittyMapSurface(rawWriteChannelFor(renderer))
		: null;

/** Frees the emitter's image slots when this cycle won't show a bitmap frame; returns the resulting active flag. */
const retireBitmapTier = (
	channel: KittyMapSurface | null,
	active: boolean,
	wanted: boolean
): boolean => {
	if (!active || wanted) {
		return active;
	}
	channel?.clear();
	return false;
};

const teardownBitmapTier = (channel: KittyMapSurface | null): void => {
	if (channel !== null) {
		channel.clear();
	}
};

const titleMarkWasClicked = (
	pane: BoxRenderable,
	event: { readonly x: number; readonly y: number }
): boolean => {
	const title = pane.title ?? "";
	const markIndex = title.indexOf(COLLAPSE_MARK);
	if (markIndex === -1 || event.y !== pane.y) {
		return false;
	}
	const start = pane.x + 2 + displayWidth(title.slice(0, markIndex));
	return event.x >= start && event.x < start + displayWidth(COLLAPSE_MARK);
};

const railMarkWasClicked = (
	pane: BoxRenderable,
	event: { readonly x: number; readonly y: number }
): boolean =>
	event.y === pane.y + 1 &&
	event.x >= pane.x + 1 &&
	event.x < pane.x + RAIL_WIDTH - 1;

/** Clips a Pane title to a cell budget, grapheme- and wide-cell-aware, so a
 * player-named map never breaks the frame. Exported for direct test coverage. */
export const clipPaneTitle = (title: string, width: number): string => {
	if (displayWidth(title) <= width) {
		return title;
	}
	let clipped = "";
	for (const { segment } of TITLE_GRAPHEMES.segment(title)) {
		if (displayWidth(`${clipped}${segment}…`) > width) {
			break;
		}
		clipped += segment;
	}
	return `${clipped}…`;
};

export type { TablePane } from "./keymap.js";

/** A contextual text task currently borrowing the Message Pane. */
type ActiveMessageTask = MessageTask<unknown> & {
	readonly origin: TablePane;
	readonly preservedDraft: string;
};

const TABLE_PANE_ORDER: readonly TablePane[] = [
	"feed",
	"map",
	"sidebar",
	"message",
];
const TABLE_LAYOUT_ORDER: readonly TableLayout[] = [
	"map-focused",
	"feed-focused",
	"no-map",
];

export const paneFocusOrder = (hasMap: boolean): readonly TablePane[] =>
	hasMap ? TABLE_PANE_ORDER : TABLE_PANE_ORDER.filter((pane) => pane !== "map");

export const initialPaneFocus = (
	layout: TableLayout,
	hasMap: boolean
): TablePane => (layout === "map-focused" && hasMap ? "map" : "feed");

export const nextPaneFocus = (
	current: TablePane,
	hasMap: boolean,
	reverse = false
): TablePane => {
	const order = paneFocusOrder(hasMap);
	const currentIndex = order.indexOf(current);
	const step = reverse ? -1 : 1;
	const nextIndex =
		(Math.max(0, currentIndex) + step + order.length) % order.length;
	return order[nextIndex] ?? "feed";
};

const feedPaneWidth = (
	layout: TableLayout,
	terminalWidth: number,
	sidebarWidth = SIDEBAR_WIDTH
): number => {
	const preferred =
		layout === "feed-focused"
			? Math.max(
					MAP_FOCUSED_FEED_WIDTH,
					Math.floor(terminalWidth * FEED_FOCUSED_FEED_RATIO)
				)
			: MAP_FOCUSED_FEED_WIDTH;
	const fit =
		terminalWidth - sidebarWidth - MAIN_PANE_GUTTERS - MINIMUM_MAP_PANE_WIDTH;
	return Math.max(MINIMUM_FEED_PANE_WIDTH, Math.min(preferred, fit));
};

/** The map grid's terminal-cell budget inside its Pane frame. */
export const tableMapRegionAvailable = (
	terminal: MapSize,
	layout: TableLayout = "map-focused",
	explicit: { readonly feedRail?: boolean; readonly sidebarRail?: boolean } = {}
): MapSize => {
	const fit = resolveTableFit(terminal, layout, explicit);
	const sidebarWidth = fit.sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH;
	const feedWidth = fit.feedRail
		? RAIL_WIDTH
		: feedPaneWidth(layout, terminal.width, sidebarWidth);
	return {
		height: mapViewportCellRows(terminal.height),
		width: Math.max(
			1,
			terminal.width -
				sidebarWidth -
				feedWidth -
				MAIN_PANE_GUTTERS -
				PANE_HORIZONTAL_BORDER_CELLS
		),
	};
};

/** The map commands the typed line can produce — the rest are chat and dice. */
type MapParsedInput = Extract<
	ParsedInput,
	{
		kind:
			| "clear-map"
			| "load-map"
			| "place-token"
			| "reglyph-token"
			| "remove-token";
	}
>;

const MAP_INPUT_KINDS: ReadonlySet<ParsedInput["kind"]> = new Set([
	"clear-map",
	"load-map",
	"place-token",
	"reglyph-token",
	"remove-token",
]);

/** Whether a parsed line is one of the map's. */
export const isMapInput = (parsed: ParsedInput): parsed is MapParsedInput =>
	MAP_INPUT_KINDS.has(parsed.kind);

/** The click handler a table wears until its cursor state exists. */
const ignoreClick = (): void => {
	// Deliberately nothing: no capability may depend on the mouse.
};

/** Pre-wiring placeholder for closures assigned after their declaration
 * cycle resolves (the lint lattice forbids forward references). */
const notYetWired = (): void => {
	// Deliberately nothing: replaced during runChrome setup.
};

const consumeKey = (key: KeyEvent): void => {
	key.preventDefault();
	key.stopPropagation();
};

/** A FeedLine's one crossing into OpenTUI: token → indexed color, named
 * attributes → packed bitmask. A plain run stays attribute-free. */
export const styledLine = (line: FeedLine): StyledText =>
	new StyledText(
		line.runs.map((run) => {
			const attributes = resolveTextAttributes(run.attrs);
			const chunk: TextChunk = {
				__isChunk: true,
				fg: resolveThemeToken(run.token),
				text: run.text,
			};
			if (attributes !== 0) {
				chunk.attributes = attributes;
			}
			return chunk;
		})
	);

/** `sameActor` is the log's link graph (ADR-0005), so the marker still finds
 * your seat after a second machine's key was linked to your identity. */
export const formatSeatList = (
	table: TableView,
	actor: string,
	sameActor: (left: string, right: string) => boolean = (left, right) =>
		left === right
): string =>
	table.seats
		.map(
			(seat) =>
				`${seat.actor !== null && sameActor(seat.actor, actor) ? "●" : "○"} ${seat.id}`
		)
		.join("\n");

const CONTROL_CHARACTER = /\p{C}/u;

export const adaptPanelKey = (
	key: Pick<KeyEvent, "ctrl" | "meta" | "name" | "sequence">
): PanelKey => {
	const characters = [...key.sequence];
	const printable =
		!key.ctrl &&
		!key.meta &&
		characters.length === 1 &&
		!CONTROL_CHARACTER.test(key.sequence);
	return printable
		? { name: key.name.toLowerCase(), text: key.sequence }
		: { name: key.name.toLowerCase() };
};

export const forwardPanelKey = <S, C>(
	key: PanelKey,
	panel: GamePanel<S, C>,
	input: GamePanelInput<S, C>
): boolean => key.name !== "v" && (panel.onKey?.(key, input) ?? false);

/** Indexed-token keybar realization. Disabled permanent actions are retained
 * as DIM chunks while Message owns printable text. */
export const styledKeybindBar = (bar: KeybindBar): StyledText => {
	const chunks: TextChunk[] = [
		{ __isChunk: true, fg: resolveThemeToken("muted"), text: `${bar.pane}  ` },
	];
	for (const [index, binding] of bar.entries.entries()) {
		const chunk: TextChunk = {
			__isChunk: true,
			fg: resolveThemeToken("muted"),
			text: `${index === 0 ? "" : "  "}${formatBinding(binding)}`,
		};
		if (binding.disabled) {
			chunk.attributes = resolveTextAttributes(["dim"] as const);
		}
		chunks.push(chunk);
	}
	return new StyledText(chunks);
};

interface PanelTab {
	readonly id: string;
}

const panelTabLayout = (
	panels: readonly PanelTab[],
	activeIndex: number
): readonly {
	readonly index: number;
	readonly start: number;
	readonly text: string;
}[] => {
	let start = 0;
	return panels.map((panel, index) => {
		const text = index === activeIndex ? `[${panel.id}]` : panel.id;
		const tab = { index, start, text };
		start += displayWidth(text) + 2;
		return tab;
	});
};

export const formatPanelTabs = (
	panels: readonly PanelTab[],
	activeIndex: number
): string =>
	panelTabLayout(panels, activeIndex)
		.map(({ text }) => text)
		.join("  ");

export const panelTabAtColumn = (
	panels: readonly PanelTab[],
	activeIndex: number,
	column: number
): number | null => {
	const tab = panelTabLayout(panels, activeIndex).find(
		({ start, text }) => column >= start && column < start + displayWidth(text)
	);
	return tab?.index ?? null;
};

export const nextPanelIndex = (
	current: number,
	panelCount: number,
	direction: -1 | 1
): number => {
	if (panelCount === 0) {
		return -1;
	}
	return (
		(((Math.max(0, current) + direction) % panelCount) + panelCount) %
		panelCount
	);
};

/** How long the stream must stay quiet before the table calls the initial
 * replay finished and flushes its collapsed skip warning (ADR-0010). The
 * RoomStore stream hands over the backlog then follows live, without marking
 * the boundary, so quiet is the honest signal available here. Erring long
 * would fold live skips into the replay summary; erring short only costs the
 * collapse, never a warning. */
const REPLAY_QUIET_MS = 250;

/** Resolves true if the next envelope beats the quiet window, false if the
 * stream falls quiet first. The timer is always cleared, so a long replay
 * leaves nothing pending behind it. */
const arrivesBeforeQuiet = async (next: Promise<unknown>): Promise<boolean> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			next.then(() => true),
			// oxlint-disable-next-line promise/avoid-new -- a bare timer needs the constructor.
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), REPLAY_QUIET_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

export const initialFeedLines = (
	notices: readonly FeedLine[] | undefined
): FeedLine[] => [...(notices ?? [])];

const feedContent = (
	lines: readonly FeedLine[],
	dimmed = false
): StyledText => {
	const chunks: TextChunk[] = [];
	for (const [index, line] of lines.entries()) {
		const styled = styledLine(line);
		chunks.push(
			...(dimmed
				? styled.chunks.map((chunk) => ({
						...chunk,
						fg: resolveThemeToken("muted"),
					}))
				: styled.chunks)
		);
		if (index < lines.length - 1) {
			chunks.push({ __isChunk: true, text: "\n" });
		}
	}
	return new StyledText(chunks);
};

// oxlint-disable-next-line eslint/complexity -- one screen, one stateful closure: ADR-0030's layered key grammar plus ADR-0032's bitmap rung; splitting further would scatter the very state these branches guard.
export const runChrome = async (options: TableOptions): Promise<void> => {
	// The renderer is the surface's: the CLI mints one over the local TTY, the
	// Door lends the one it owns for the session (ADR-0016). The table only
	// draws on it — it never starts a render loop of its own (ADR-0012) and
	// never destroys it: it detaches its renderables and resolves.
	const { renderer } = options;
	let done = false;
	let finish: (() => void) | undefined;
	// The bitmap tier's channel: capability verdict at connect, multiplexer
	// guard, guarded raw writes. Null means this session never has a bitmap
	// rung — the ladder is pixel↔text exactly as ADR-0007 pinned it. Declared
	// before `settle` because teardown frees its image slots.
	const bitmapChannel = createBitmapChannel(renderer);
	/** Whether the emitter currently holds images on the terminal — the flag that makes leaving bitmap mode a teardown, not a leak. */
	let bitmapActive = false;
	// oxlint-disable-next-line promise/avoid-new -- a screen's exit is an event, not a promise-returning API.
	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const settle = (): void => {
		done = true;
		// The bitmap tier's image slots outlive the renderer's cell teardown —
		// free them so a session end never leaves images baked into the
		// player's terminal. The channel no-ops once the renderer is destroyed.
		teardownBitmapTier(bitmapChannel);
		bitmapActive = false;
		finish?.();
	};
	// The backstop for exits the table does not decide: the surface tearing the
	// session down (or Ctrl+C, which destroys the renderer) must still resolve
	// this screen.
	const onRendererDestroy = (): void => settle();
	renderer.on(CliRenderEvents.DESTROY, onRendererDestroy);
	const replay = await options.store.replay?.();
	const checkpoint =
		replay?.checkpoint === undefined
			? undefined
			: readTableCheckpoint(replay.checkpoint.payload);
	const fold = createTableFold(
		options.entry as ViewEntry<unknown, unknown, unknown>,
		options.gameId,
		options.session.actor,
		checkpoint?.fold
	);
	const lines = [
		...initialFeedLines(options.entry.view.notices),
		...(checkpoint?.feed ?? []),
	];
	const panels = options.entry.view.createPanels();
	let layout = options.viewOptions?.layout ?? "map-focused";
	let focusMarker = options.viewOptions?.focusMarker ?? false;
	const initialRails = explicitRailPreferences(options);
	let explicitFeedRail = initialRails.feedRail;
	let explicitSidebarRail = initialRails.sidebarRail;
	let fit: TableFit = resolveTableFit(
		{ height: renderer.terminalHeight, width: renderer.terminalWidth },
		layout,
		{ feedRail: explicitFeedRail, sidebarRail: explicitSidebarRail }
	);
	let feedRailActivity = 0;
	const paneFrame = {
		borderColor: resolveThemeToken("muted"),
		borderStyle: "single" as const,
		focusable: true,
		focusedBorderColor: resolveThemeToken("accent"),
	};
	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		width: "100%",
	});
	const header = new TextRenderable(renderer, {
		content: `${options.roomLabel} · ${options.gameId}`,
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	const main = new BoxRenderable(renderer, {
		columnGap: 1,
		flexDirection: "row",
		flexGrow: 1,
		width: "100%",
	});
	const feedPane = new BoxRenderable(renderer, {
		...paneFrame,
		flexDirection: "column",
		flexGrow: 1,
		title: "feed",
	});
	const feed = new ScrollBoxRenderable(renderer, {
		flexGrow: 1,
		rootOptions: { flexGrow: 1 },
		scrollbarOptions: {
			arrowOptions: { foregroundColor: resolveThemeToken("primary") },
			trackOptions: {
				backgroundColor: resolveThemeToken("muted"),
				foregroundColor: resolveThemeToken("primary"),
			},
		},
	});
	const feedText = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		width: "100%",
	});
	feed.add(feedText);
	feedPane.add(feed);
	const feedRailSummary = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		visible: false,
		width: "100%",
	});
	feedPane.add(feedRailSummary);
	// The battle map is core chrome's own Pane — not a layout Slot. Slots place
	// module Panels, so a game can never claim this core surface (ADR-0006).
	const mapPane = new BoxRenderable(renderer, {
		...paneFrame,
		flexDirection: "column",
		flexGrow: 1,
		title: "map",
		visible: false,
	});
	const mapStatus = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		height: MAP_STATUS_ROWS,
		width: "100%",
	});
	// The click handler is wired once the cursor state below exists; until then
	// a click is simply ignored, which is exactly what click promises anyway.
	let onMapClick: (cell: MapCursor) => void = ignoreClick;
	const mapSurface = new MapSurfaceRenderable(
		renderer,
		{ height: 1, width: 1 },
		(cell) => onMapClick(cell)
	);
	mapPane.add(mapSurface);
	mapPane.add(mapStatus);
	const sidebarPane = new BoxRenderable(renderer, {
		...paneFrame,
		flexDirection: "column",
		title: "sidebar",
		width: SIDEBAR_WIDTH,
	});
	const sidebarSeats = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		width: "100%",
	});
	const sidebarTabs = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	const sidebarPanel = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		width: "100%",
	});
	sidebarPane.add(sidebarSeats);
	sidebarPane.add(sidebarTabs);
	sidebarPane.add(sidebarPanel);
	const sidebarRailSummary = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		visible: false,
		width: "100%",
	});
	sidebarPane.add(sidebarRailSummary);
	const status = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	const messagePane = new BoxRenderable(renderer, {
		...paneFrame,
		flexDirection: "column",
		height: MESSAGE_PANE_ROWS,
		title: "message",
		width: "100%",
	});
	const input = new InputRenderable(renderer, {
		cursorColor: resolveThemeToken("accent"),
		focusedTextColor: resolveThemeToken("primary"),
		maxLength: 1100,
		placeholder: "Message, /roll NdS+M, /map load <name>, /token place <glyph>",
		placeholderColor: resolveThemeToken("muted"),
		textColor: resolveThemeToken("primary"),
		width: "100%",
	});
	messagePane.add(input);
	const keybindBar = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	main.add(feedPane);
	main.add(mapPane);
	main.add(sidebarPane);
	root.add(header);
	root.add(main);
	root.add(status);
	root.add(messagePane);
	root.add(keybindBar);
	const tooSmallSurface = new TextRenderable(renderer, {
		content:
			"terminal too small\n\nincrease the terminal size to show feed, sidebar, message, status, and keys.",
		fg: resolveThemeToken("primary"),
		height: "100%",
		visible: false,
		width: "100%",
	});
	root.add(tooSmallSurface);
	const keySheetInputLayer = new BoxRenderable(renderer, {
		bottom: 0,
		left: 0,
		position: "absolute",
		right: 0,
		top: 0,
		visible: false,
		zIndex: 99,
	});
	keySheetInputLayer.onMouseDown = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	root.add(keySheetInputLayer);
	const keySheet = new BoxRenderable(renderer, {
		backgroundColor: RGBA.defaultBackground(),
		borderColor: resolveThemeToken("accent"),
		borderStyle: "single",
		bottom: 2,
		flexDirection: "column",
		left: 2,
		position: "absolute",
		right: 2,
		title: "keys",
		titleColor: resolveThemeToken("accent"),
		top: 2,
		visible: false,
		zIndex: 100,
	});
	const keySheetText = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		width: "100%",
	});
	keySheet.add(keySheetText);
	keySheet.onMouseDown = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	root.add(keySheet);
	renderer.root.add(root);

	let focusedPane: TablePane = initialPaneFocus(layout, false);
	let keySheetOpen = false;
	let messageOrigin: TablePane = focusedPane;
	let messageTask: ActiveMessageTask | null = null;
	let focusInteracted = false;
	let replaying = true;
	let idleStatusContent = "";
	let idleStatusToken: "danger" | "muted" = "muted";
	let cursor: MapCursor = { x: 0, y: 0 };
	let selectedTokenId: string | null = null;
	// Bitmap is the default when the connect-time check confirmed kitty
	// graphics (ADR-0032); otherwise the ladder is pixel↔text with no
	// detection anywhere near it (ADR-0007/0021). The toggle stays
	// per-session, keyboard-only, and never persists.
	let mapMode: MapRenderMode =
		bitmapChannel === null ? "pixel" : "bitmap";
	const tierLadder: readonly MapRenderMode[] =
		bitmapChannel === null ? ["pixel", "text"] : ["bitmap", "pixel", "text"];
	// The frame hook fires from the surface's paint; the emitter answers with
	// the placeholder layout the surface spells into its own cells. No
	// occluder wiring exists: chrome over the map is ordinary higher-z text
	// over ordinary placeholder text (the #134-validated mechanism).
	mapSurface.onBitmapFrame = wireBitmapHook(
		{
			// Renderer destroy routes through `settle` (the DESTROY listener),
			// so `done` alone covers the destroyed-renderer case too.
			blocked: () => done,
			channel: bitmapChannel,
		},
		() => {
			bitmapActive = true;
		}
	);
	/** Tears the bitmap rung down when this cycle won't render one. */
	const retireBitmapIfIdle = (mapPresent: boolean): void => {
		bitmapActive = retireBitmapTier(
			bitmapChannel,
			bitmapActive,
			mapMode === "bitmap" && mapPresent && !fit.tooSmall
		);
	};
	let lastMapName: string | null = null;
	let activePanelIndex = panels.length === 0 ? -1 : 0;
	let focusSidebar = notYetWired;
	const activePanel = (): GamePanel<unknown, unknown> | undefined =>
		panels[activePanelIndex];
	const mapIsPresent = (): boolean =>
		fold.map() !== null && layout !== "no-map";
	const mapFocused = (): boolean => focusedPane === "map";
	const ownSeatId = (): string | null =>
		fold
			.table()
			.seats.find(
				(seat) =>
					seat.actor !== null &&
					fold.sameActor(seat.actor, options.session.actor)
			)?.id ?? null;
	const interaction = (): MapInteraction | null => {
		const map = fold.map();
		return map === null
			? null
			: { cursor, map, selectedTokenId, tokens: fold.tokens() };
	};
	const paneTitle = (pane: TablePane, label: string): string =>
		focusMarker && focusedPane === pane ? `> ${label}` : label;
	const renderPaneTitles = (): void => {
		feedPane.title = fit.feedRail
			? ""
			: paneTitle("feed", `feed ${COLLAPSE_MARK}`);
		sidebarPane.title = fit.sidebarRail
			? ""
			: paneTitle("sidebar", `sidebar ${COLLAPSE_MARK}`);
		messagePane.title = paneTitle("message", messageTask?.title ?? "message");
		const map = fold.map();
		const mapLabel = map === null ? "map" : `map · ${map.name}`;
		const sidebarWidth = fit.sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH;
		const currentFeedWidth = fit.feedRail
			? RAIL_WIDTH
			: feedPaneWidth(layout, renderer.terminalWidth, sidebarWidth);
		const mapTitleWidth =
			renderer.terminalWidth -
			currentFeedWidth -
			sidebarWidth -
			MAIN_PANE_GUTTERS -
			PANE_TITLE_END_CELLS;
		mapPane.title = clipPaneTitle(
			paneTitle("map", mapLabel),
			Math.max(1, mapTitleWidth)
		);
		keybindBar.content = styledKeybindBar(
			deriveKeybindBar(
				focusedPane,
				focusedPane === "message",
				renderer.terminalWidth
			)
		);
	};
	const recomputeFit = (): void => {
		const previousFeedRail = fit.feedRail;
		fit = resolveTableFit(
			{ height: renderer.terminalHeight, width: renderer.terminalWidth },
			layout,
			{ feedRail: explicitFeedRail, sidebarRail: explicitSidebarRail }
		);
		if (previousFeedRail && !fit.feedRail) {
			feedRailActivity = 0;
		}
	};
	const applyPaneLayout = (): void => {
		recomputeFit();
		const normalSurfaceVisible = !fit.tooSmall;
		header.visible = normalSurfaceVisible;
		main.visible = normalSurfaceVisible;
		status.visible = normalSurfaceVisible;
		messagePane.visible = normalSurfaceVisible;
		keybindBar.visible = normalSurfaceVisible;
		tooSmallSurface.visible = fit.tooSmall;
		if (fit.tooSmall) {
			return;
		}
		const hasMap = mapIsPresent();
		mapPane.visible = hasMap;
		feed.visible = !fit.feedRail;
		feedRailSummary.visible = fit.feedRail;
		sidebarSeats.visible = !fit.sidebarRail;
		sidebarTabs.visible = !fit.sidebarRail && panels.length > 0;
		sidebarPanel.visible = !fit.sidebarRail;
		sidebarRailSummary.visible = fit.sidebarRail;
		sidebarPane.width = fit.sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH;
		if (fit.feedRail) {
			feedPane.flexGrow = 0;
			feedPane.width = RAIL_WIDTH;
			return;
		}
		if (hasMap) {
			feedPane.flexGrow = 0;
			feedPane.width = feedPaneWidth(
				layout,
				renderer.terminalWidth,
				fit.sidebarRail ? RAIL_WIDTH : SIDEBAR_WIDTH
			);
			return;
		}
		feedPane.flexShrink = 1;
		feedPane.width = "auto";
		feedPane.flexGrow = 1;
	};
	const renderStatus = (): void => {
		if (done) {
			return;
		}
		status.fg = resolveThemeToken(
			keySheetOpen || idleStatusContent === "" ? "muted" : idleStatusToken
		);
		if (idleStatusContent !== "") {
			status.content = idleStatusContent;
			return;
		}
		if (focusedPane === "map") {
			status.content =
				"map: arrows/hjkl move · Enter picks up and drops · x removes · t cycles map tier";
			return;
		}
		const panel = activePanel();
		status.content =
			focusedPane === "sidebar" && panel !== undefined
				? `panel: ${panel.id}`
				: "";
	};
	/** Redraws the region from the folded map and the local cursor. The whole
	 * surface is one cell grid, so this is the only place map pixels are set. */
	const renderMap = (): void => {
		if (done) {
			return;
		}
		const map = fold.map();
		applyPaneLayout();
		retireBitmapIfIdle(map !== null && layout !== "no-map");
		if (map === null || layout === "no-map") {
			lastMapName = null;
			selectedTokenId = null;
			if (focusedPane === "map") {
				focusedPane = initialPaneFocus(layout, false);
				feedPane.focus();
				renderStatus();
			}
			renderPaneTitles();
			return;
		}
		if (!focusInteracted && replaying && layout === "map-focused") {
			focusedPane = initialPaneFocus(layout, true);
			mapPane.focus();
			renderStatus();
		}
		if (map.name !== lastMapName) {
			lastMapName = map.name;
			cursor = { x: 0, y: 0 };
			selectedTokenId = null;
		}
		const size = mapRegionSize(
			map,
			tableMapRegionAvailable(
				{
					height: renderer.terminalHeight,
					width: renderer.terminalWidth,
				},
				layout,
				{ feedRail: explicitFeedRail, sidebarRail: explicitSidebarRail }
			),
			mapMode
		);
		mapSurface.width = size.width;
		mapSurface.height = size.height;
		renderPaneTitles();
		mapStatus.content = styledLine(
			mapStatusLine({
				cursor: mapFocused() ? cursor : null,
				map,
				selectedTokenId,
				tokens: fold.tokens(),
			})
		);
		mapSurface.update({
			cursor: mapFocused() ? cursor : null,
			dimmed: keySheetOpen,
			map,
			mode: mapMode,
			ownSeatId: ownSeatId(),
			selectedTokenId,
			tokens: fold.tokens(),
		});
	};
	/** A submit that never came back. Two honest answers, never one: a command
	 * that could not be written did not land, while a command whose answer was
	 * lost may have. Neither is ever resubmitted for you (ADR-0001). */
	const showConnectionLost = (error: unknown): void => {
		if (done) {
			return;
		}
		idleStatusToken = "danger";
		idleStatusContent =
			error instanceof Error && error.name === "SubmissionUncertainError"
				? "Connection lost. Whether the command landed is unknown — check the feed before sending it again."
				: "Connection lost. The command was not delivered.";
		renderStatus();
	};
	const showSubmission = (result: RoomSubmission): void => {
		if (done) {
			return;
		}
		if ("rejected" in result) {
			idleStatusToken = "danger";
			idleStatusContent = result.message;
		} else {
			idleStatusContent = "";
		}
		renderStatus();
	};
	const dispatchPanelCommand = (command: unknown): void => {
		void options.store
			.submit({
				actor: options.session.actor,
				command,
			})
			.then(showSubmission)
			.catch(showConnectionLost);
	};
	const panelInput = (focused: boolean): GamePanelInput<unknown, unknown> => ({
		dispatch: dispatchPanelCommand,
		focused,
		requestMessageTask: (task) => {
			// A re-request while a task is pending abandons the stale task but
			// must carry its preserved ordinary draft forward — the input holds
			// the stale task's contextual text, never the ordinary draft.
			messageTask = {
				...task,
				origin: focusedPane,
				preservedDraft: messageTask?.preservedDraft ?? input.value,
			};
			// Inlined focus move (focusPane is lexically later; the lint lattice
			// forbids the forward reference). The sidebar repaint is owned by the
			// keypress call site: forwardPanelKey returning true triggers
			// renderSidebar, and render() never invokes requestMessageTask.
			focusedPane = "message";
			focusInteracted = true;
			input.value = "";
			input.focus();
			renderPaneTitles();
			renderStatus();
			renderMap();
		},
		state: fold.state(),
		table: fold.table(),
	});
	const panelRows: TextRenderable[] = [];
	let repaintSidebar = notYetWired;
	const createPanelRow = (row: number): TextRenderable => {
		const renderable = new TextRenderable(renderer, {
			content: "",
			fg: resolveThemeToken("primary"),
			width: "100%",
		});
		renderable.onMouseDown = (event) => {
			event.preventDefault();
			event.stopPropagation();
			focusSidebar();
			const clickedPanel = activePanel();
			if (clickedPanel?.onRowClick?.(row, panelInput(true)) === true) {
				repaintSidebar();
			}
		};
		panelRows.push(renderable);
		sidebarPanel.add(renderable);
		return renderable;
	};
	const renderRailSummaries = (): void => {
		feedRailSummary.content = formatFeedRail(
			feedRailActivity,
			Math.max(0, feedPane.height - PANE_HORIZONTAL_BORDER_CELLS)
		).join("\n");
		sidebarRailSummary.content = formatSidebarRail(
			fold.table().seats,
			Math.max(0, sidebarPane.height - PANE_HORIZONTAL_BORDER_CELLS)
		).join("\n");
	};
	const renderSidebar = (): void => {
		if (done) {
			return;
		}
		const tableToken = keySheetOpen ? "muted" : "primary";
		sidebarSeats.fg = resolveThemeToken(tableToken);
		sidebarRailSummary.fg = resolveThemeToken(tableToken);
		for (const row of panelRows) {
			row.fg = resolveThemeToken(tableToken);
		}
		renderRailSummaries();
		if (fit.sidebarRail) {
			return;
		}
		sidebarSeats.content = formatSeatList(
			fold.table(),
			options.session.actor,
			fold.sameActor
		);
		sidebarTabs.content = formatPanelTabs(panels, activePanelIndex);
		sidebarTabs.visible = panels.length > 0;
		const panel = activePanel();
		const panelLines =
			panel?.render(panelInput(focusedPane === "sidebar")) ?? [];
		for (const [row, panelLine] of panelLines.entries()) {
			const renderable = panelRows[row] ?? createPanelRow(row);
			renderable.content = panelLine.runs.map((run) => run.text).join("");
			renderable.visible = true;
		}
		for (const renderable of panelRows.slice(panelLines.length)) {
			renderable.visible = false;
		}
	};
	repaintSidebar = renderSidebar;
	const setUnderlyingDimmed = (dimmed: boolean): void => {
		const frameColor = resolveThemeToken(dimmed ? "muted" : "accent");
		for (const pane of [feedPane, mapPane, sidebarPane, messagePane]) {
			pane.focusedBorderColor = frameColor;
		}
		const contentToken = resolveThemeToken(dimmed ? "muted" : "primary");
		feedRailSummary.fg = contentToken;
		mapStatus.fg = contentToken;
		input.textColor = contentToken;
		input.focusedTextColor = contentToken;
		feedText.content = feedContent(lines, dimmed);
		renderStatus();
		renderSidebar();
		renderMap();
	};
	const setKeySheetOpen = (open: boolean): void => {
		keySheetOpen = open;
		keySheetInputLayer.visible = open;
		keySheet.visible = open;
		if (open) {
			keySheetText.content = deriveKeySheet(
				focusedPane,
				focusedPane === "sidebar" ? activePanel() : undefined
			);
		}
		setUnderlyingDimmed(open);
	};
	const focusPane = (requested: TablePane, interacted = true): void => {
		const hasMap = mapIsPresent();
		const next =
			requested === "map" && !hasMap
				? initialPaneFocus(layout, false)
				: requested;
		const previous = focusedPane;
		focusedPane = next;
		if (next === "message" && previous !== "message" && messageTask === null) {
			messageOrigin = previous;
		}
		focusInteracted ||= interacted;
		if (next === "message") {
			input.focus();
		} else {
			(({ feed: feedPane, map: mapPane, sidebar: sidebarPane }) as const)[
				next
			].focus();
		}
		renderPaneTitles();
		renderStatus();
		renderMap();
		if (previous === "sidebar" || next === "sidebar") {
			renderSidebar();
		}
	};
	focusSidebar = (): void => focusPane("sidebar");
	const notifyPreference = (change: TablePreferenceChange): void => {
		options.onPreferenceChange?.(change);
	};
	const toggleRail = (pane: "feed" | "sidebar"): void => {
		if (fit.tooSmall) {
			return;
		}
		const nextFeedRail = pane === "feed" ? !explicitFeedRail : explicitFeedRail;
		const nextSidebarRail =
			pane === "sidebar" ? !explicitSidebarRail : explicitSidebarRail;
		const nextFit = resolveTableFit(
			{ height: renderer.terminalHeight, width: renderer.terminalWidth },
			layout,
			{ feedRail: nextFeedRail, sidebarRail: nextSidebarRail }
		);
		const visiblyChanges =
			pane === "feed"
				? nextFit.feedRail !== fit.feedRail
				: nextFit.sidebarRail !== fit.sidebarRail;
		if (!visiblyChanges) {
			return;
		}
		if (pane === "feed") {
			explicitFeedRail = nextFeedRail;
			notifyPreference({ preference: "feedRail", value: explicitFeedRail });
		} else {
			explicitSidebarRail = nextSidebarRail;
			notifyPreference({
				preference: "sidebarRail",
				value: explicitSidebarRail,
			});
		}
		renderMap();
		renderSidebar();
	};
	sidebarTabs.onMouseDown = (event) => {
		event.preventDefault();
		event.stopPropagation();
		focusSidebar();
		const clickedIndex = panelTabAtColumn(
			panels,
			activePanelIndex,
			event.x - sidebarTabs.x
		);
		if (clickedIndex !== null && clickedIndex !== activePanelIndex) {
			activePanelIndex = clickedIndex;
			renderSidebar();
			renderStatus();
		}
	};
	feedPane.onMouseDown = (event) => {
		event.preventDefault();
		event.stopPropagation();
		const toggles = fit.feedRail
			? railMarkWasClicked(feedPane, event)
			: titleMarkWasClicked(feedPane, event);
		focusPane("feed");
		if (toggles) {
			toggleRail("feed");
		}
	};
	mapPane.onMouseDown = (event) => {
		event.preventDefault();
		focusPane("map");
	};
	sidebarPane.onMouseDown = (event) => {
		event.preventDefault();
		event.stopPropagation();
		const toggles = fit.sidebarRail
			? railMarkWasClicked(sidebarPane, event)
			: titleMarkWasClicked(sidebarPane, event);
		focusPane("sidebar");
		if (toggles) {
			toggleRail("sidebar");
		}
	};
	messagePane.onMouseDown = (event) => {
		event.preventDefault();
		focusPane("message");
	};
	const showNotice = (message: string): void => {
		idleStatusToken = "muted";
		idleStatusContent = message;
		renderStatus();
	};
	const dispatchCore = async (command: CoreCommand): Promise<void> => {
		try {
			const submission = await options.store.submit({
				actor: options.session.actor,
				command,
			});
			if (done) {
				return;
			}
			showSubmission(submission);
		} catch (error) {
			if (done) {
				return;
			}
			showConnectionLost(error);
		}
	};
	/** The one place the map cursor moves — arrow keys and mouse click alike.
	 * Click is progressive enhancement: it reaches nothing keys cannot. */
	const moveCursorTo = (cell: MapCursor): void => {
		cursor = cell;
		if (!mapFocused()) {
			focusPane("map");
			return;
		}
		renderStatus();
		renderMap();
	};
	onMapClick = moveCursorTo;
	const submitMapInput = async (parsed: MapParsedInput): Promise<void> => {
		const result = mapCommandFor(parsed, interaction());
		if ("message" in result) {
			showNotice(result.message);
			return;
		}
		await dispatchCore(result.command);
	};
	const returnFromMessage = (origin: TablePane): void => {
		const available = paneFocusOrder(mapIsPresent());
		focusPane(
			available.includes(origin)
				? origin
				: initialPaneFocus(layout, mapIsPresent())
		);
	};
	const finishMessageTask = (): TablePane | null => {
		const task = messageTask;
		if (task === null) {
			return null;
		}
		messageTask = null;
		input.value = task.preservedDraft;
		renderPaneTitles();
		return task.origin;
	};
	const submitInput = async (value: unknown): Promise<void> => {
		if (typeof value !== "string") {
			return;
		}
		const task = messageTask;
		if (task !== null) {
			const command = task.submit(value);
			const origin = finishMessageTask();
			if (origin !== null) {
				returnFromMessage(origin);
			}
			dispatchPanelCommand(command);
			return;
		}
		// Clear before the async submit: keystrokes that arrive while the
		// submission is in flight must land in an empty field, not on the
		// already-submitted text.
		input.value = "";
		returnFromMessage(messageOrigin);
		const parsed = parseInput(value);
		if (parsed.kind === "quit") {
			settle();
			return;
		}
		if (parsed.kind === "unknown-command") {
			showNotice(`Unknown command '${parsed.command}'.`);
			return;
		}
		if (parsed.kind === "usage") {
			showNotice(parsed.message);
			return;
		}
		if (parsed.kind === "empty") {
			return;
		}
		if (isMapInput(parsed)) {
			await submitMapInput(parsed);
			return;
		}
		await dispatchCore(
			parsed.kind === "chat"
				? { text: parsed.text, type: "core.chat" }
				: { notation: parsed.notation, type: "core.roll" }
		);
	};
	input.on(InputRenderableEvents.ENTER, (value: unknown) => {
		void submitInput(value);
	});
	/** Cycles the available tiers along ADR-0032's ladder — bitmap → pixel →
	 * text, bitmap only present when the connect check confirmed it. Leaving
	 * bitmap mode frees the terminal's image slots; the next paint repaints
	 * real cells over the region. */
	const toggleMapMode = (): void => {
		const next =
			tierLadder[(tierLadder.indexOf(mapMode) + 1) % tierLadder.length];
		mapMode = next ?? "pixel";
		// renderMap retires the bitmap rung itself when the new tier isn't it.
		renderMap();
	};
	/** Applies one map action. Every branch is reachable by keyboard alone;
	 * false means the Map did not claim the key (notably inert Esc, #126). */
	const applyMapAction = (state: MapInteraction, key: PanelKey): boolean => {
		const action = mapKeyAction(state, key);
		if (action === null) {
			return false;
		}
		if (action.kind === "cursor") {
			({ cursor } = action);
		} else if (action.kind === "select") {
			selectedTokenId = action.tokenId;
		} else if (action.kind === "notice") {
			showNotice(action.message);
		} else if (action.kind === "toggle-render-mode") {
			toggleMapMode();
		} else {
			selectedTokenId = null;
			void dispatchCore(action.command).then(renderMap, renderMap);
		}
		renderMap();
		return true;
	};
	const cycleLayout = (): void => {
		const current = TABLE_LAYOUT_ORDER.indexOf(layout);
		layout =
			TABLE_LAYOUT_ORDER[(current + 1) % TABLE_LAYOUT_ORDER.length] ??
			"map-focused";
		renderMap();
		renderSidebar();
	};
	const handleFeedKey = (key: KeyEvent): boolean => {
		if (key.name === "c") {
			toggleRail("feed");
			return true;
		}
		if (key.name === "up" || key.name === "k") {
			feed.scrollBy(-1);
			return true;
		}
		if (key.name === "down" || key.name === "j") {
			feed.scrollBy(1);
			return true;
		}
		if (key.name === "pageup" || key.name === "pagedown") {
			feed.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
			return true;
		}
		if (key.name === "home" || key.name === "end") {
			feed.scrollTo(key.name === "home" ? 0 : Number.MAX_SAFE_INTEGER);
			return true;
		}
		return false;
	};
	// oxlint-disable-next-line eslint/complexity -- branches directly implement ADR-0030's complete layered key grammar.
	const onKeypress = (key: KeyEvent): void => {
		if (keySheetOpen) {
			consumeKey(key);
			if (key.name === "?" || key.name === "escape") {
				setKeySheetOpen(false);
			} else if (key.name === "f") {
				focusMarker = !focusMarker;
				notifyPreference({ preference: "focusMarker", value: focusMarker });
				renderPaneTitles();
			} else if (key.name === "t") {
				toggleMapMode();
			}
			return;
		}
		if (key.name === "tab") {
			consumeKey(key);
			focusPane(nextPaneFocus(focusedPane, mapIsPresent(), key.shift));
			return;
		}
		if (focusedPane === "message") {
			if (key.name === "escape") {
				consumeKey(key);
				const taskOrigin = finishMessageTask();
				returnFromMessage(taskOrigin ?? messageOrigin);
			}
			return;
		}
		if (key.name === "?" && !key.ctrl && !key.meta) {
			consumeKey(key);
			setKeySheetOpen(true);
			return;
		}
		if (key.name === "v" && !key.ctrl && !key.meta && !key.shift) {
			consumeKey(key);
			cycleLayout();
			return;
		}
		if (focusedPane === "feed") {
			if (handleFeedKey(key)) {
				consumeKey(key);
			}
			return;
		}
		if (focusedPane === "map") {
			const state = interaction();
			if (state !== null && applyMapAction(state, adaptPanelKey(key))) {
				consumeKey(key);
			}
			return;
		}
		if (focusedPane !== "sidebar") {
			return;
		}
		if (key.name === "left" || key.name === "right") {
			consumeKey(key);
			activePanelIndex = nextPanelIndex(
				activePanelIndex,
				panels.length,
				key.name === "left" ? -1 : 1
			);
			renderSidebar();
			renderStatus();
			return;
		}
		if (key.name === "c") {
			consumeKey(key);
			toggleRail("sidebar");
			return;
		}
		const panel = activePanel();
		if (
			panel !== undefined &&
			forwardPanelKey(adaptPanelKey(key), panel, panelInput(true))
		) {
			consumeKey(key);
			renderSidebar();
		}
	};
	renderer.keyInput.on("keypress", onKeypress);
	const unsubscribeResize = options.session.onResize(({ columns, rows }) => {
		renderer.resize(columns, rows);
		renderMap();
		renderSidebar();
	});
	const unsubscribeClose = options.session.onClose(settle);
	// The hold is the caller's honesty channel: a line to show while the table
	// waits on something outside the terminal, and a promise that ends it.
	const unsubscribeHold = options.hold?.onNotice((message) => {
		idleStatusToken = "danger";
		idleStatusContent = message;
		renderStatus();
	});
	options.hold?.until.then(settle, settle);
	feedText.content = feedContent(lines, keySheetOpen);
	renderSidebar();
	renderMap();
	focusPane(initialPaneFocus(layout, mapIsPresent()), false);
	// #130's readiness boundary, honestly placed: every input route above is
	// attached and the initial Pane focus is chosen, so the Door may now hand
	// over the input it preserved. An internal handoff — no Log event, no
	// Door-protocol signal.
	options.onInputReady?.();

	const iterator = (replay?.stream ?? options.store.stream(1))[
		Symbol.asyncIterator
	]();
	const renderFold = (): void => {
		// The stream can hand over one more envelope after this screen exited;
		// drawing on a detached tree (or a renderer the surface already tore
		// down) throws out of the loop instead of ending it.
		if (done || renderer.isDestroyed) {
			return;
		}
		feedText.content = feedContent(lines, keySheetOpen);
		feed.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
		renderSidebar();
		renderMap();
	};
	const showFeed = (line: FeedLine | null): void => {
		if (line !== null) {
			lines.push(line);
			if (fit.feedRail) {
				feedRailActivity += 1;
			}
		}
		renderFold();
	};
	void (async () => {
		const batchInitialReplay = replay !== undefined;
		const replayThroughSeq = replay?.throughSeq;
		let pending: Promise<IteratorResult<Envelope>> | null = null;
		const finishReplay = (): void => {
			if (!replaying) {
				return;
			}
			const warning = fold.endReplay();
			if (warning !== null) {
				lines.push(warning);
			}
			// Initial replay is one projection update, not one redraw per Envelope.
			// The latter made join CPU grow quadratically with history length.
			// `replaying` flips only after this render so a map that arrived in a
			// batched replay tail still receives layout-derived initial focus.
			renderFold();
			replaying = false;
		};
		if (replayThroughSeq === 0) {
			finishReplay();
		}
		// oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `settle` flips `done` from the exit paths that run between this loop's awaits.
		while (!done) {
			pending ??= iterator.next();
			if (replaying && !batchInitialReplay) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- legacy stores expose no boundary; their replay ends at the first quiet gap.
				const arrived = await arrivesBeforeQuiet(pending);
				if (!arrived) {
					finishReplay();
					continue;
				}
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- each stream envelope must be consumed in order.
			const next = await pending;
			pending = null;
			if (next.done || done) {
				finishReplay();
				break;
			}
			const line = fold.apply(next.value);
			if (replaying && batchInitialReplay) {
				if (line !== null) {
					lines.push(line);
				}
			} else {
				showFeed(line);
			}
			if (
				replaying &&
				replayThroughSeq !== undefined &&
				next.value.seq >= replayThroughSeq
			) {
				finishReplay();
			}
		}
	})();
	await exited;
	unsubscribeResize();
	unsubscribeClose();
	unsubscribeHold?.();
	void iterator.return?.();
	renderer.keyInput.off("keypress", onKeypress);
	renderer.off(CliRenderEvents.DESTROY, onRendererDestroy);
	// Borrowed, not owned: detach this screen's renderables and hand the
	// renderer back intact (ADR-0016). Destroy is idempotent, so a surface
	// that already tore the renderer down costs nothing here.
	root.destroyRecursively();
};
