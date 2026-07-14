import type { RoomStore, ViewEntry } from "@supervillain/core";
import type { Session } from "@supervillain/session";

import { runChrome } from "./chrome.js";

export interface TableOptions {
	readonly session: Session;
	readonly store: RoomStore;
	readonly entry: ViewEntry<unknown, unknown, unknown>;
	readonly roomLabel: string;
	readonly gameId: string;
}

/** Renders the table on the session's terminal; resolves when the table exits
 * (/quit, Ctrl+C, or session close). */
export const runTable = (options: TableOptions): Promise<void> =>
	runChrome(options);
