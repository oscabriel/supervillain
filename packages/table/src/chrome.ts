/* oxlint-disable promise/prefer-await-to-then -- panel dispatch is synchronously fire-and-forget and the pinned contract requires a rejection catch. */
import {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from "@opentui/core";
import type { KeyEvent, TextChunk } from "@opentui/core";
import type {
	Envelope,
	FeedLine,
	GamePanel,
	GamePanelInput,
	PanelKey,
	RoomSubmission,
	TableView,
	ViewEntry,
} from "@supervillain/core";

import { createTableFold } from "./fold.js";
import type { TableOptions } from "./index.js";
import { parseInput } from "./input.js";
import { resolveThemeToken } from "./theme.js";

const styledLine = (line: FeedLine): StyledText =>
	new StyledText(
		line.runs.map((run) => ({
			__isChunk: true,
			fg: resolveThemeToken(run.token),
			text: run.text,
		}))
	);

export const formatSeatList = (table: TableView, actor: string): string =>
	table.seats
		.map((seat) => `${seat.actor === actor ? "●" : "○"} ${seat.id}`)
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
	const initialSize = options.session.size();
	let finish: (() => void) | undefined;
	// oxlint-disable-next-line promise/avoid-new -- OpenTUI exposes teardown through an onDestroy callback.
	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		height: initialSize.rows,
		onDestroy: () => finish?.(),
		stdin: options.session.input,
		stdout: options.session.output,
		width: initialSize.columns,
	});
	const fold = createTableFold(
		options.entry as ViewEntry<unknown, unknown, unknown>,
		options.gameId,
		options.session.actor
	);
	const lines = initialFeedLines(options.entry.view.notices);
	const panels = options.entry.view.createPanels();
	const root = new BoxRenderable(renderer, {
		flexDirection: "column",
		height: "100%",
		width: "100%",
	});
	const header = new TextRenderable(renderer, {
		content: `${options.roomLabel} · ${options.gameId}`,
		fg: resolveThemeToken("primary"),
		height: 1,
	});
	const main = new BoxRenderable(renderer, {
		flexDirection: "row",
		flexGrow: 1,
	});
	const feed = new ScrollBoxRenderable(renderer, {
		flexGrow: 1,
		rootOptions: { flexGrow: 1 },
	});
	const feedText = new TextRenderable(renderer, { content: "", width: "100%" });
	feed.add(feedText);
	const sidebar = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: 28,
	});
	const sidebarText = new TextRenderable(renderer, {
		content: "",
		width: "100%",
	});
	sidebar.add(sidebarText);
	const status = new TextRenderable(renderer, {
		content: "",
		fg: resolveThemeToken("muted"),
		height: 1,
	});
	const input = new InputRenderable(renderer, {
		cursorColor: resolveThemeToken("accent"),
		maxLength: 1100,
		placeholder: "Message or /roll NdS+M",
		placeholderColor: resolveThemeToken("muted"),
		textColor: resolveThemeToken("primary"),
	});
	main.add(feed);
	main.add(sidebar);
	root.add(header);
	root.add(main);
	root.add(status);
	root.add(input);
	renderer.root.add(root);

	let focusedPanelIndex = -1;
	let idleStatusContent = "";
	let idleStatusToken: "danger" | "muted" = "muted";
	const interactivePanels = panels.filter((panel) => panel.onKey !== undefined);
	const renderStatus = (): void => {
		const focused = interactivePanels[focusedPanelIndex];
		status.fg = resolveThemeToken(focused ? "muted" : idleStatusToken);
		status.content = focused
			? `panel: ${focused.id} — Esc to return`
			: idleStatusContent;
	};
	const showConnectionLost = (): void => {
		idleStatusToken = "danger";
		idleStatusContent = "Connection lost. The command was not delivered.";
		renderStatus();
	};
	const showSubmission = (result: RoomSubmission): void => {
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
		const seats = formatSeatList(fold.table(), options.session.actor);
		const focusedPanel = interactivePanels[focusedPanelIndex];
		const panelLines = panels.flatMap((panel) =>
			panel
				.render(panelInput(panel === focusedPanel))
				.map((line) => line.runs.map((run) => run.text).join(""))
		);
		sidebarText.content = ["Seats", seats, "", ...panelLines].join("\n");
	};
	const teardown = (): void => {
		if (!renderer.isDestroyed) {
			renderer.destroy();
		}
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
			teardown();
			return;
		}
		if (parsed.kind === "unknown-command") {
			idleStatusToken = "muted";
			idleStatusContent = `Unknown command '${parsed.command}'.`;
			renderStatus();
			return;
		}
		if (parsed.kind === "empty") {
			return;
		}
		const command =
			parsed.kind === "chat"
				? { text: parsed.text, type: "core.chat" }
				: { notation: parsed.notation, type: "core.roll" };
		try {
			const result = await options.store.submit({
				actor: options.session.actor,
				command,
			});
			showSubmission(result);
		} catch {
			showConnectionLost();
		}
	};
	input.on(InputRenderableEvents.ENTER, (value: unknown) => {
		void submitInput(value);
	});
	const focusInput = (): void => {
		const previousPanelIndex = focusedPanelIndex;
		focusedPanelIndex = -1;
		input.focus();
		renderStatus();
		rerenderOnPanelFocusTransition(
			previousPanelIndex,
			focusedPanelIndex,
			renderSidebar
		);
	};
	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (key.name === "tab") {
			key.preventDefault();
			key.stopPropagation();
			const previousPanelIndex = focusedPanelIndex;
			focusedPanelIndex = nextPanelFocus(
				focusedPanelIndex,
				interactivePanels.length
			);
			if (focusedPanelIndex === -1) {
				input.focus();
			} else {
				input.blur();
			}
			renderStatus();
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
		if (key.name === "escape") {
			focusInput();
			return;
		}
		const panel = interactivePanels[focusedPanelIndex];
		if (
			panel !== undefined &&
			forwardPanelKey(adaptPanelKey(key), panel, panelInput(true))
		) {
			renderSidebar();
		}
	});
	const unsubscribeResize = options.session.onResize(({ columns, rows }) =>
		renderer.resize(columns, rows)
	);
	const unsubscribeClose = options.session.onClose(teardown);
	feedText.content = feedContent(lines);
	renderSidebar();
	input.focus();
	renderer.start();

	const iterator = options.store.stream(1)[Symbol.asyncIterator]();
	const showFeed = (line: FeedLine | null): void => {
		if (line !== null) {
			lines.push(line);
		}
		feedText.content = feedContent(lines);
		feed.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
		renderSidebar();
	};
	void (async () => {
		let replaying = true;
		let pending: Promise<IteratorResult<Envelope>> | null = null;
		while (!renderer.isDestroyed) {
			pending ??= iterator.next();
			if (replaying) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- the replay boundary is the first quiet gap in this stream, which only sequential waiting can see.
				const arrived = await arrivesBeforeQuiet(pending);
				if (!arrived) {
					replaying = false;
					showFeed(fold.endReplay());
					continue;
				}
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- each stream envelope must be consumed in order.
			const next = await pending;
			pending = null;
			if (next.done || renderer.isDestroyed) {
				break;
			}
			showFeed(fold.apply(next.value));
		}
	})();
	await exited;
	unsubscribeResize();
	unsubscribeClose();
	void iterator.return?.();
};
