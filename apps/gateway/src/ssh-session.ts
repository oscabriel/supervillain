/* oxlint-disable promise/prefer-await-to-callbacks -- node's Writable is callback-shaped. */
import { Writable } from "node:stream";

import type {
	Session,
	TerminalConnection,
	TerminalSize,
} from "@supervillain/session";

import { clampPtySize } from "./capacity.js";
import type { PtySize } from "./capacity.js";

/** The slice of an `@opentui/ssh` session the Door adapts — structural, so the
 * session contract stays untyped to the SSH implementation behind it and tests
 * drive it with plain fakes. */
export interface DoorChannel {
	readonly cols: number;
	readonly rows: number;
	readonly write: (data: Buffer | string) => void;
	readonly onResize: (
		listener: (cols: number, rows: number) => void
	) => () => void;
	readonly onClose: (listener: () => void) => () => void;
}

export interface DoorConnectionOptions {
	readonly channel: DoorChannel;
	/** The read side of the SSH channel; the library owns it and hands it to
	 * the renderer, so the Door borrows rather than re-derives it. */
	readonly input: NodeJS.ReadStream;
	/** The Door's rendered-PTY ceiling (ADR-0012, NQ-14). The library clamps at
	 * its own 500x200; this brings the announced size down to the R9-gated cap
	 * before any screen reads it. */
	readonly cap: PtySize;
}

/**
 * Adapts one `@opentui/ssh` session to the terminal-connection contract. The
 * library owns the channel, the renderer, output backpressure, and teardown;
 * this only re-expresses them as `TerminalConnection` and applies the Door's
 * PTY cap, so every screen sees a terminal it is allowed to draw.
 *
 * `close()` here releases the *screens* (they resolve and hand the goodbye
 * back), never the SSH session: the Door ends the library's session itself,
 * after the goodbye is written — otherwise the farewell would race the
 * teardown it is supposed to precede.
 */
export const attachDoorConnection = (
	options: DoorConnectionOptions
): TerminalConnection => {
	const { cap, channel } = options;
	let size = clampPtySize({ columns: channel.cols, rows: channel.rows }, cap);
	let closed = false;
	const resizeListeners = new Set<(next: TerminalSize) => void>();
	const closeListeners = new Set<() => void>();
	// Every write goes straight back to the library's session, whose channel
	// write defers acknowledgement until the peer drains — the Door buffers
	// nothing of its own, so a slow reader stalls only its own session.
	const output = new Writable({
		write(chunk: Buffer | string, _encoding, callback) {
			channel.write(chunk);
			callback();
		},
	}) as unknown as NodeJS.WriteStream;
	output.columns = size.columns;
	output.rows = size.rows;
	/** Everything this adapter subscribed to the library's session, dropped in
	 * one place so teardown leaves nothing listening. */
	const detach: (() => void)[] = [
		channel.onResize((cols, rows) => {
			size = clampPtySize({ columns: cols, rows }, cap);
			output.columns = size.columns;
			output.rows = size.rows;
			for (const listener of resizeListeners) {
				listener(size);
			}
		}),
	];
	const notifyClose = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		for (const listener of closeListeners) {
			listener();
		}
		closeListeners.clear();
		resizeListeners.clear();
		for (const off of detach) {
			off();
		}
		detach.length = 0;
	};
	detach.push(channel.onClose(notifyClose));
	return {
		close() {
			notifyClose();
		},
		input: options.input,
		onClose(listener) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onResize(listener) {
			resizeListeners.add(listener);
			return () => resizeListeners.delete(listener);
		},
		output,
		size: () => size,
	};
};

/** Binds an actor to the connection, producing the session a table needs. The
 * connection outlives it: a guest hops rooms on one minted actor, and the same
 * terminal is handed back to the lobby afterwards. */
export const sessionForActor = (
	connection: TerminalConnection,
	actor: string
): Session => ({ ...connection, actor });
