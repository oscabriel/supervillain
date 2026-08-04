/* oxlint-disable promise/prefer-await-to-then -- panel dispatch is synchronously fire-and-forget and the pinned contract requires a rejection catch. */
import {
	BoxRenderable,
	CliRenderEvents,
	InputRenderable,
	InputRenderableEvents,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from "@opentui/core";
import type { KeyEvent, TextChunk } from "@opentui/core";
import type {
	CoreCommand,
	Envelope,
	FeedLine,
	GamePanel,
	GamePanelInput,
	PanelKey,
	RoomSubmission,
	TableView,
	ViewEntry,
} from "@supervillain/core";

import { readTableCheckpoint } from "./checkpoint.js";
import { createTableFold } from "./fold.js";
import type { TableLayout, TableOptions } from "./index.js";
import { parseInput } from "./input.js";
import type { ParsedInput } from "./input.js";
import { mapCommandFor, mapKeyAction } from "./map-interaction.js";
import type { MapInteraction } from "./map-interaction.js";
import {
	MapSurfaceRenderable,
	mapRegionSize,
	mapViewportCellRows,
} from "./map-region.js";
import type { MapRenderMode } from "./map-region.js";
import { mapStatusLine } from "./map.js";
import type { MapCursor } from "./map.js";
import { resolveTextAttributes, resolveThemeToken } from "./theme.js";

const SIDEBAR_WIDTH = 28;
const MAP_FOCUSED_FEED_WIDTH = 26;
const MINIMUM_FEED_PANE_WIDTH = 12;
const MINIMUM_MAP_PANE_WIDTH = 18;
const FEED_FOCUSED_FEED_RATIO = 0.42;
const MAIN_PANE_GUTTERS = 2;
const PANE_HORIZONTAL_BORDER_CELLS = 2;
const MESSAGE_PANE_ROWS = 3;
const MAP_STATUS_ROWS = 1;
const PANE_TITLE_END_CELLS = 4;
const TITLE_GRAPHEMES = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});
const displayWidth = (
	globalThis as typeof globalThis & {
		readonly Bun: { readonly stringWidth: (text: string) => number };
	}
).Bun.stringWidth;

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

/** The stable Table Pane vocabulary and traversal order from ADR-0030. */
export type TablePane = "feed" | "map" | "message" | "sidebar";

const TABLE_PANE_ORDER: readonly TablePane[] = [
	"feed",
	"map",
	"sidebar",
	"message",
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

const feedPaneWidth = (layout: TableLayout, terminalWidth: number): number => {
	const preferred =
		layout === "feed-focused"
			? Math.max(
					MAP_FOCUSED_FEED_WIDTH,
					Math.floor(terminalWidth * FEED_FOCUSED_FEED_RATIO)
				)
			: MAP_FOCUSED_FEED_WIDTH;
	const fit =
		terminalWidth - SIDEBAR_WIDTH - MAIN_PANE_GUTTERS - MINIMUM_MAP_PANE_WIDTH;
	return Math.max(MINIMUM_FEED_PANE_WIDTH, Math.min(preferred, fit));
};

/** The map grid's terminal-cell budget inside its Pane frame. */
export const tableMapRegionAvailable = (
	terminal: { readonly width: number; readonly height: number },
	layout: TableLayout = "map-focused"
): { readonly width: number; readonly height: number } => ({
	height: mapViewportCellRows(terminal.height),
	width: Math.max(
		1,
		terminal.width -
			SIDEBAR_WIDTH -
			feedPaneWidth(layout, terminal.width) -
			MAIN_PANE_GUTTERS -
			PANE_HORIZONTAL_BORDER_CELLS
	),
});

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

/** A FeedLine's one crossing into OpenTUI: token → indexed color, named
 * attributes → packed bitmask. A plain run stays attribute-free. */
export const styledLine = (line: FeedLine): StyledText =>
	new StyledText(
		line.runs.map((run) => {
			const attributes = resolveTextAttributes(run.attrs);
			return {
				__isChunk: true as const,
				fg: resolveThemeToken(run.token),
				text: run.text,
				...(attributes === 0 ? {} : { attributes }),
			};
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
): boolean => panel.onKey?.(key, input) ?? false;

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

const feedContent = (lines: readonly FeedLine[]): StyledText => {
	const chunks: TextChunk[] = [];
	for (const [index, line] of lines.entries()) {
		chunks.push(...styledLine(line).chunks);
		if (index < lines.length - 1) {
			chunks.push({ __isChunk: true, text: "\n" });
		}
	}
	return new StyledText(chunks);
};

export const runChrome = async (options: TableOptions): Promise<void> => {
	// The renderer is the surface's: the CLI mints one over the local TTY, the
	// Door lends the one it owns for the session (ADR-0016). The table only
	// draws on it — it never starts a render loop of its own (ADR-0012) and
	// never destroys it: it detaches its renderables and resolves.
	const { renderer } = options;
	let done = false;
	let finish: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- a screen's exit is an event, not a promise-returning API.
	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const settle = (): void => {
		done = true;
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
	const layout = options.viewOptions?.layout ?? "map-focused";
	const focusMarker = options.viewOptions?.focusMarker ?? false;
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
	const sidebarText = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		width: "100%",
	});
	sidebarPane.add(sidebarText);
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
	renderer.root.add(root);

	let focusedPane: TablePane = initialPaneFocus(layout, false);
	let focusInteracted = false;
	let replaying = true;
	let idleStatusContent = "";
	let idleStatusToken: "danger" | "muted" = "muted";
	let cursor: MapCursor = { x: 0, y: 0 };
	let selectedTokenId: string | null = null;
	// Pixel is the default and the toggle is the whole ceremony: per-session,
	// no capability detection, no persistence at v1 (ADR-0007/0021).
	let mapMode: MapRenderMode = "pixel";
	let lastMapName: string | null = null;
	const activePanel = panels.find((panel) => panel.onKey !== undefined);
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
		feedPane.title = paneTitle("feed", "feed");
		sidebarPane.title = paneTitle("sidebar", "sidebar");
		messagePane.title = paneTitle("message", "message");
		const map = fold.map();
		const mapLabel = map === null ? "map" : `map · ${map.name}`;
		const mapTitleWidth =
			renderer.terminalWidth -
			feedPaneWidth(layout, renderer.terminalWidth) -
			SIDEBAR_WIDTH -
			MAIN_PANE_GUTTERS -
			PANE_TITLE_END_CELLS;
		mapPane.title = clipPaneTitle(
			paneTitle("map", mapLabel),
			Math.max(1, mapTitleWidth)
		);
		keybindBar.content = `${focusedPane}  [tab] pane`;
	};
	const applyPaneLayout = (): void => {
		const hasMap = mapIsPresent();
		mapPane.visible = hasMap;
		if (hasMap) {
			feedPane.flexGrow = 0;
			feedPane.width = feedPaneWidth(layout, renderer.terminalWidth);
			return;
		}
		feedPane.width = "auto";
		feedPane.flexGrow = 1;
	};
	const renderStatus = (): void => {
		if (done) {
			return;
		}
		status.fg = resolveThemeToken(
			idleStatusContent === "" ? "muted" : idleStatusToken
		);
		if (idleStatusContent !== "") {
			status.content = idleStatusContent;
			return;
		}
		if (focusedPane === "map") {
			status.content =
				"map: arrows/hjkl move · Enter picks up and drops · x removes · t toggles text mode";
			return;
		}
		status.content =
			focusedPane === "sidebar" && activePanel !== undefined
				? `panel: ${activePanel.id}`
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
				layout
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
	const panelInput = (focused: boolean): GamePanelInput<unknown, unknown> => ({
		dispatch: (command: unknown) => {
			void options.store
				.submit({
					actor: options.session.actor,
					command,
				})
				.then(showSubmission)
				.catch(showConnectionLost);
		},
		focused,
		state: fold.state(),
		table: fold.table(),
	});
	const renderSidebar = (): void => {
		if (done) {
			return;
		}
		const seats = formatSeatList(
			fold.table(),
			options.session.actor,
			fold.sameActor
		);
		const panelLines = panels.flatMap((panel) =>
			panel
				.render(panelInput(focusedPane === "sidebar" && panel === activePanel))
				.map((line) => line.runs.map((run) => run.text).join(""))
		);
		sidebarText.content = [
			seats,
			...(seats === "" || panelLines.length === 0 ? [] : [""]),
			...panelLines,
		].join("\n");
	};
	const focusPane = (requested: TablePane, interacted = true): void => {
		const hasMap = mapIsPresent();
		const next =
			requested === "map" && !hasMap
				? initialPaneFocus(layout, false)
				: requested;
		const previous = focusedPane;
		focusedPane = next;
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
	feedPane.onMouseDown = (event) => {
		event.preventDefault();
		focusPane("feed");
	};
	mapPane.onMouseDown = (event) => {
		event.preventDefault();
		focusPane("map");
	};
	sidebarPane.onMouseDown = (event) => {
		event.preventDefault();
		focusPane("sidebar");
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
	const submitInput = async (value: unknown): Promise<void> => {
		if (typeof value !== "string") {
			return;
		}
		// Clear before the async submit: keystrokes that arrive while the
		// submission is in flight must land in an empty field, not on the
		// already-submitted text.
		input.value = "";
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
	const focusInput = (): void => focusPane("message");
	/** Applies one map action. Every branch is reachable by keyboard alone. */
	const applyMapAction = (state: MapInteraction, key: PanelKey): void => {
		const action = mapKeyAction(state, key);
		if (action === null) {
			return;
		}
		if (action.kind === "cursor") {
			({ cursor } = action);
		} else if (action.kind === "select") {
			selectedTokenId = action.tokenId;
		} else if (action.kind === "unfocus") {
			focusInput();
			return;
		} else if (action.kind === "notice") {
			showNotice(action.message);
		} else if (action.kind === "toggle-render-mode") {
			mapMode = mapMode === "pixel" ? "text" : "pixel";
		} else {
			selectedTokenId = null;
			void dispatchCore(action.command).then(renderMap, renderMap);
		}
		renderMap();
	};
	const onKeypress = (key: KeyEvent): void => {
		if (key.name === "tab") {
			key.preventDefault();
			key.stopPropagation();
			focusPane(nextPaneFocus(focusedPane, mapIsPresent(), key.shift));
			return;
		}
		if (focusedPane === "message") {
			return;
		}
		if (focusedPane === "map") {
			key.preventDefault();
			key.stopPropagation();
			const state = interaction();
			if (state !== null) {
				applyMapAction(state, adaptPanelKey(key));
			}
			return;
		}
		if (focusedPane !== "sidebar") {
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		if (key.name === "escape") {
			focusInput();
			return;
		}
		if (
			activePanel !== undefined &&
			forwardPanelKey(adaptPanelKey(key), activePanel, panelInput(true))
		) {
			renderSidebar();
		}
	};
	renderer.keyInput.on("keypress", onKeypress);
	const unsubscribeResize = options.session.onResize(({ columns, rows }) => {
		renderer.resize(columns, rows);
		renderMap();
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
	feedText.content = feedContent(lines);
	renderSidebar();
	renderMap();
	focusPane(initialPaneFocus(layout, mapIsPresent()), false);

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
		feedText.content = feedContent(lines);
		feed.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
		renderSidebar();
		renderMap();
	};
	const showFeed = (line: FeedLine | null): void => {
		if (line !== null) {
			lines.push(line);
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
