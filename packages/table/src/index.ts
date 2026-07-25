import type { RoomStore, ViewEntry } from "@supervillain/core";
import type { Session } from "@supervillain/session";

import { runChrome } from "./chrome.js";
import type { TableRendererFactory } from "./renderer.js";

export interface TableOptions {
	readonly session: Session;
	readonly store: RoomStore;
	readonly entry: ViewEntry<unknown, unknown, unknown>;
	readonly roomLabel: string;
	readonly gameId: string;
	/** Supplies the renderer this table draws on — and with it the decision of
	 * whether a render loop runs at all. */
	readonly createRenderer: TableRendererFactory;
}

export { createLocalTtyRenderer, createSessionRenderer } from "./renderer.js";
export type { TableRendererFactory } from "./renderer.js";

/** Renders the table on the session's terminal; resolves when the table exits
 * (/quit, Ctrl+C, or session close). */
export const runTable = (options: TableOptions): Promise<void> =>
	runChrome(options);
