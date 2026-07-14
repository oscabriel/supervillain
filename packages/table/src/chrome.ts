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
import type { TextChunk } from "@opentui/core";
import type {
	FeedLine,
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
		options.gameId
	);
	const lines: FeedLine[] = [];
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

	const showConnectionLost = (): void => {
		status.fg = resolveThemeToken("danger");
		status.content = "Connection lost. The command was not delivered.";
	};
	const renderSidebar = (): void => {
		const table = fold.table();
		const seats = formatSeatList(table, options.session.actor);
		const panelLines = options.entry.view.panels
			.map((panel) =>
				panel.render({
					dispatch: (command: unknown) => {
						void options.store
							.submit({
								actor: options.session.actor,
								command,
							})
							.catch(showConnectionLost);
					},
					state: fold.state(),
					table,
				})
			)
			.map((line) => line.runs.map((run) => run.text).join(""));
		sidebarText.content = ["Seats", seats, "", ...panelLines].join("\n");
	};
	const teardown = (): void => {
		if (!renderer.isDestroyed) {
			renderer.destroy();
		}
	};
	const showSubmission = (result: RoomSubmission): void => {
		if ("rejected" in result) {
			status.fg = resolveThemeToken("danger");
			status.content = result.message;
		} else {
			status.content = "";
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
			status.fg = resolveThemeToken("muted");
			status.content = `Unknown command '${parsed.command}'.`;
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
	const unsubscribeResize = options.session.onResize(({ columns, rows }) =>
		renderer.resize(columns, rows)
	);
	const unsubscribeClose = options.session.onClose(teardown);
	renderSidebar();
	input.focus();
	renderer.start();

	const iterator = options.store.stream(1)[Symbol.asyncIterator]();
	void (async () => {
		while (!renderer.isDestroyed) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- each stream envelope must be consumed in order.
			const next = await iterator.next();
			if (next.done || renderer.isDestroyed) {
				break;
			}
			const line = fold.apply(next.value);
			if (line !== null) {
				lines.push(line);
			}
			feedText.content = feedContent(lines);
			feed.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
			renderSidebar();
		}
	})();
	await exited;
	unsubscribeResize();
	unsubscribeClose();
	void iterator.return?.();
};
