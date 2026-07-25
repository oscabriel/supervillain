import type { RoomStore, ViewEntry } from "@supervillain/core";
import type { Session } from "@supervillain/session";

import { runChrome } from "./chrome.js";
import type { TableRendererFactory } from "./renderer.js";

/**
 * What holds a table open, and what ends it from outside the terminal. The
 * gateway uses it for ADR-0012's grace window: when the Host goes offline the
 * seat is held with an honest notice, and when the window runs out `until`
 * resolves and the table hands the terminal back to whoever called it.
 *
 * The table takes no position on *why*: it shows the line and closes when told.
 */
export interface TableHold {
	/** Subscribes to honest one-line notices shown in the status line. */
	readonly onNotice: (listener: (message: string) => void) => () => void;
	/** Resolves when the table must tear down and hand the terminal back. */
	readonly until: Promise<void>;
}

export interface TableOptions {
	readonly session: Session;
	readonly store: RoomStore;
	readonly entry: ViewEntry<unknown, unknown, unknown>;
	readonly roomLabel: string;
	readonly gameId: string;
	/** Supplies the renderer this table draws on — and with it the decision of
	 * whether a render loop runs at all. */
	readonly createRenderer: TableRendererFactory;
	/** An outside signal that may notice at, and close, this table. */
	readonly hold?: TableHold;
}

export { createLocalTtyRenderer, createSessionRenderer } from "./renderer.js";
export type { TableRendererFactory } from "./renderer.js";

/** Renders the table on the session's terminal; resolves when the table exits
 * (/quit, Ctrl+C, or session close). */
export const runTable = (options: TableOptions): Promise<void> =>
	runChrome(options);
