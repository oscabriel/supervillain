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
import { bandHeader, ruleHeader, verticalBandDivider } from "./chrome-frame.js";
import { createTableFold } from "./fold.js";
import type { TableOptions } from "./index.js";
import { parseInput } from "./input.js";
import type { ParsedInput } from "./input.js";
import { mapCommandFor, mapKeyAction } from "./map-interaction.js";
import type { MapInteraction } from "./map-interaction.js";
import {
	MAP_VIEWPORT_MAX_ROWS,
	MapSurfaceRenderable,
	mapRegionSize,
} from "./map-region.js";
import type { MapRenderMode } from "./map-region.js";
import { mapStatusLine, mapTitleLine } from "./map.js";
import type { MapCursor } from "./map.js";
import { resolveTextAttributes, resolveThemeToken } from "./theme.js";

const SIDEBAR_WIDTH = 28;
const FRAME_DIVIDER_WIDTH = 1;
const FIXED_BAND_ROWS = 4;

/** The map region's own focus stop, ahead of the module panels: chrome's
 * region is chrome's, and a module panel can never claim it. */
const MAP_FOCUS = "map";

type FocusTarget = typeof MAP_FOCUS | GamePanel<unknown, unknown>;

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

export const nextPanelFocus = (current: number, count: number): number =>
	count === 0 || current >= count - 1 ? -1 : current + 1;

export const rerenderOnPanelFocusTransition = (
	previousPanelIndex: number,
	nextPanelIndex: number,
	rerender: () => void
): void => {
	if (previousPanelIndex !== nextPanelIndex) {
		rerender();
	}
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
	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		width: "100%",
	});
	const header = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	const main = new BoxRenderable(renderer, {
		flexDirection: "row",
		flexGrow: 1,
	});
	const center = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
	});
	const feedHeader = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
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
	const mainDivider = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		flexShrink: 0,
		height: "100%",
		width: FRAME_DIVIDER_WIDTH,
	});
	const sidebar = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: SIDEBAR_WIDTH,
	});
	const sidebarText = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		width: "100%",
	});
	sidebar.add(sidebarText);
	const stateHeader = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
		width: "100%",
	});
	const status = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
	});
	const input = new InputRenderable(renderer, {
		cursorColor: resolveThemeToken("accent"),
		focusedTextColor: resolveThemeToken("primary"),
		maxLength: 1100,
		placeholder: "Message, /roll NdS+M, /map load <name>, /token place <glyph>",
		placeholderColor: resolveThemeToken("muted"),
		textColor: resolveThemeToken("primary"),
	});
	// The battle map is core chrome's own region — not a layout slot. Slots
	// place *module* panels, and `LayoutSlot` keeps its single member precisely
	// so a module can never claim this surface (ADR-0006).
	const mapRegion = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexShrink: 0,
		visible: false,
	});
	const mapTitle = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		height: 1,
	});
	const mapStatus = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("primary"),
		height: 1,
	});
	// The click handler is wired once the cursor state below exists; until then
	// a click is simply ignored, which is exactly what click promises anyway.
	let onMapClick: (cell: MapCursor) => void = ignoreClick;
	const mapSurface = new MapSurfaceRenderable(
		renderer,
		{ height: 1, width: 1 },
		(cell) => onMapClick(cell)
	);
	mapRegion.add(mapTitle);
	mapRegion.add(mapSurface);
	mapRegion.add(mapStatus);
	center.add(mapRegion);
	center.add(feedHeader);
	center.add(feed);
	main.add(center);
	main.add(mainDivider);
	main.add(sidebar);
	root.add(header);
	root.add(main);
	root.add(stateHeader);
	root.add(status);
	root.add(input);
	renderer.root.add(root);

	let focusedPanelIndex = -1;
	let idleStatusContent = "";
	let idleStatusToken: "danger" | "muted" = "muted";
	let cursor: MapCursor = { x: 0, y: 0 };
	let selectedTokenId: string | null = null;
	// Pixel is the default and the toggle is the whole ceremony: per-session,
	// no capability detection, no persistence at v1 (ADR-0007/0021).
	let mapMode: MapRenderMode = "pixel";
	let lastMapName: string | null = null;
	let mapRegionRows = 0;
	const interactivePanels = panels.filter((panel) => panel.onKey !== undefined);
	/** The focus ring: chrome's map region first when one is loaded, then the
	 * module's interactive panels, then back to the input line. */
	const focusTargets = (): readonly FocusTarget[] =>
		fold.map() === null ? interactivePanels : [MAP_FOCUS, ...interactivePanels];
	const focusedTarget = (): FocusTarget | undefined =>
		focusTargets()[focusedPanelIndex];
	const mapFocused = (): boolean => focusedTarget() === MAP_FOCUS;
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
	const centerWidth = (): number =>
		Math.max(1, renderer.terminalWidth - SIDEBAR_WIDTH - FRAME_DIVIDER_WIDTH);
	/** Reflows every rule from live terminal dimensions. One vertical rule marks
	 * the sidebar; center-region headers compute real meetings against it. */
	const renderFrame = (): void => {
		const width = renderer.terminalWidth;
		header.content = styledLine(
			bandHeader({
				leftLabel: `${options.roomLabel} · ${options.gameId}`,
				rightLabel: "seats",
				rightWidth: SIDEBAR_WIDTH,
				vertical: "down",
				width,
			})
		);
		feedHeader.content = styledLine(ruleHeader("feed", centerWidth()));
		stateHeader.content = styledLine(
			bandHeader({
				leftLabel: "state",
				rightLabel: "",
				rightWidth: SIDEBAR_WIDTH,
				vertical: "up",
				width,
			})
		);
		const map = fold.map();
		if (map !== null) {
			// The map producer owns this copy; the chrome grammar deliberately
			// normalizes every region title to the same header styling.
			const label = mapTitleLine(map)
				.runs.map((run) => run.text)
				.join("");
			mapTitle.content = styledLine(ruleHeader(label, centerWidth()));
		}
		const junctionRows = map === null ? [0] : [0, mapRegionRows];
		mainDivider.content = styledLine({
			runs: [
				{
					attrs: ["dim"],
					text: verticalBandDivider(
						Math.max(0, renderer.terminalHeight - FIXED_BAND_ROWS),
						junctionRows
					),
					token: "muted",
				},
			],
		});
	};
	const renderStatus = (): void => {
		if (done) {
			return;
		}
		const focused = focusedTarget();
		status.fg = resolveThemeToken(
			focused === undefined ? idleStatusToken : "muted"
		);
		if (focused === MAP_FOCUS) {
			status.content =
				"map: arrows/hjkl move · Enter picks up and drops · x removes · t toggles text mode · Esc returns";
			return;
		}
		status.content =
			focused === undefined
				? idleStatusContent
				: `panel: ${focused.id} — Esc to return`;
	};
	/** Redraws the region from the folded map and the local cursor. The whole
	 * surface is one cell grid, so this is the only place map pixels are set. */
	const renderMap = (): void => {
		if (done) {
			return;
		}
		const map = fold.map();
		if (map === null) {
			mapRegion.visible = false;
			mapRegionRows = 0;
			lastMapName = null;
			selectedTokenId = null;
			renderFrame();
			return;
		}
		if (map.name !== lastMapName) {
			lastMapName = map.name;
			cursor = { x: 0, y: 0 };
			selectedTokenId = null;
		}
		const size = mapRegionSize(
			map,
			{
				height: MAP_VIEWPORT_MAX_ROWS,
				// ADR-0021's 4×3 tile geometry is unchanged; chrome spends exactly
				// one additional terminal column on the sidebar's single-side rule.
				width: centerWidth(),
			},
			mapMode
		);
		mapSurface.width = size.width;
		mapSurface.height = size.height;
		// The title and status lines ride above and below the grid; naming the
		// region's height keeps the feed from being laid out over it.
		mapRegionRows = size.height + 2;
		mapRegion.height = mapRegionRows;
		mapRegion.visible = true;
		renderFrame();
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
		const focusedPanel = focusedTarget();
		const panelLines = panels.flatMap((panel) =>
			panel
				.render(panelInput(panel === focusedPanel))
				.map((line) => line.runs.map((run) => run.text).join(""))
		);
		sidebarText.content = [
			seats,
			...(seats === "" || panelLines.length === 0 ? [] : [""]),
			...panelLines,
		].join("\n");
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
			const index = focusTargets().indexOf(MAP_FOCUS);
			if (index !== -1) {
				focusedPanelIndex = index;
				input.blur();
			}
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
	const focusInput = (): void => {
		const previousPanelIndex = focusedPanelIndex;
		focusedPanelIndex = -1;
		input.focus();
		renderStatus();
		renderMap();
		rerenderOnPanelFocusTransition(
			previousPanelIndex,
			focusedPanelIndex,
			renderSidebar
		);
	};
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
			const previousPanelIndex = focusedPanelIndex;
			focusedPanelIndex = nextPanelFocus(
				focusedPanelIndex,
				focusTargets().length
			);
			if (focusedPanelIndex === -1) {
				input.focus();
			} else {
				input.blur();
			}
			renderStatus();
			renderMap();
			rerenderOnPanelFocusTransition(
				previousPanelIndex,
				focusedPanelIndex,
				renderSidebar
			);
			return;
		}
		if (focusedPanelIndex === -1) {
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		const focused = focusedTarget();
		if (focused === MAP_FOCUS) {
			const state = interaction();
			if (state !== null) {
				applyMapAction(state, adaptPanelKey(key));
			}
			return;
		}
		if (key.name === "escape") {
			focusInput();
			return;
		}
		if (
			focused !== undefined &&
			forwardPanelKey(adaptPanelKey(key), focused, panelInput(true))
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
	input.focus();

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
		let replaying = true;
		let pending: Promise<IteratorResult<Envelope>> | null = null;
		const finishReplay = (): void => {
			if (!replaying) {
				return;
			}
			replaying = false;
			const warning = fold.endReplay();
			if (warning !== null) {
				lines.push(warning);
			}
			// Initial replay is one projection update, not one redraw per Envelope.
			// The latter made join CPU grow quadratically with history length.
			renderFold();
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
