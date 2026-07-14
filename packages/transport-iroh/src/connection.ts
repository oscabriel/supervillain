import type { Connection as NativeConnection } from "@number0/iroh";

import type { TransportConnection, TransportRoute } from "./seam.js";

const CLOSE_CODE = 0n;
const CLOSE_REASON = [...new TextEncoder().encode("closed")];
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class IrohConnection implements TransportConnection {
	readonly #connection: NativeConnection;
	readonly #onClose: () => void;
	#closed = false;

	constructor(connection: NativeConnection, onClose: () => void) {
		this.#connection = connection;
		this.#onClose = onClose;
	}

	get remoteId(): string {
		return Buffer.from(this.#connection.remoteId().toBytes()).toString("hex");
	}

	get route(): TransportRoute {
		const selected = this.#connection.paths().find((path) => path.isSelected);
		if (selected?.isRelay === true) {
			return "relay";
		}
		if (selected?.isIp === true) {
			return "direct";
		}
		return "unknown";
	}

	async send(message: Uint8Array): Promise<void> {
		if (this.#closed) {
			throw new Error("Transport connection is closed");
		}
		if (message.byteLength > MAX_MESSAGE_BYTES) {
			throw new RangeError(
				`Transport message exceeds ${MAX_MESSAGE_BYTES} bytes`
			);
		}

		const frame = new Uint8Array(4 + message.byteLength);
		new DataView(frame.buffer).setUint32(0, message.byteLength, false);
		frame.set(message, 4);

		const stream = await this.#connection.openUni();
		await stream.writeAll([...frame]);
		await stream.finish();
	}

	async receive(): Promise<Uint8Array> {
		if (this.#closed) {
			throw new Error("Transport connection is closed");
		}

		const stream = await this.#connection.acceptUni();
		const header = Uint8Array.from(await stream.readExact(4));
		const length = new DataView(header.buffer).getUint32(0, false);
		if (length > MAX_MESSAGE_BYTES) {
			await stream.stop(1n);
			throw new RangeError(
				`Transport message exceeds ${MAX_MESSAGE_BYTES} bytes`
			);
		}
		if (length === 0) {
			return new Uint8Array();
		}
		return Uint8Array.from(await stream.readExact(length));
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#connection.close(CLOSE_CODE, CLOSE_REASON);
		try {
			await this.#connection.closed();
		} finally {
			this.#onClose();
		}
	}
}
