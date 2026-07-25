import type { TransportConnection } from "@supervillain/room-wire";

import type { WsChannel } from "./channel.js";

/** One WebSocket message carries one seam message; nothing larger is framed. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

/** A `room-wire` connection over one authenticated WebSocket. WebSocket already
 * delimits messages, so the seam adds no length framing of its own. */
export class WsTransportConnection implements TransportConnection {
	readonly #channel: WsChannel;
	readonly #onClose: () => void;
	readonly remoteId: string;
	#closed = false;

	constructor(channel: WsChannel, remoteId: string, onClose: () => void) {
		this.#channel = channel;
		this.remoteId = remoteId;
		this.#onClose = onClose;
	}

	send(message: Uint8Array): Promise<void> {
		if (message.byteLength > MAX_MESSAGE_BYTES) {
			return Promise.reject(
				new RangeError(`Transport message exceeds ${MAX_MESSAGE_BYTES} bytes`)
			);
		}
		try {
			this.#channel.send(message);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve();
	}

	async receive(): Promise<Uint8Array> {
		const message = await this.#channel.next();
		// Runtimes disagree about whether a text frame lands as a string or as
		// bytes; the seam speaks bytes either way.
		return typeof message === "string" ? encoder.encode(message) : message;
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		try {
			await this.#channel.close();
		} finally {
			this.#onClose();
		}
	}
}
