import type {
	TransportConnection,
	TransportDialer,
} from "@supervillain/room-wire";

import { WsChannel } from "./channel.js";
import type { WebSocketLike } from "./channel.js";
import { WsTransportConnection } from "./connection.js";
import {
	DialTimeoutError,
	InvalidTransportUrlError,
	SelfDialError,
} from "./errors.js";
import { authenticate } from "./handshake.js";
import { loadSigningKey } from "./keys.js";

export { MAX_MESSAGE_BYTES } from "./connection.js";
export {
	DialTimeoutError,
	HandshakeError,
	InvalidTransportUrlError,
	SelfDialError,
} from "./errors.js";

const DEFAULT_DIAL_TIMEOUT_MS = 5000;

export interface WsDialerOptions {
	/** The `ws:` or `wss:` URL every dial opens a connection to. */
	readonly url: string;
	/** 64 lowercase hex chars (ed25519 seed) — the identity this side proves. */
	readonly secretKeyHex: string;
	/** Maximum time in ms for one dial, handshake included. Default: 5000ms. */
	readonly dialTimeoutMs?: number;
}

export interface WsDialer extends TransportDialer {
	/** This dialer's own identity — 64 lowercase hex chars. */
	readonly localId: string;
	/** The URL this dialer opens connections to. */
	readonly url: string;
	/** Closes every connection this dialer opened. */
	readonly close: () => Promise<void>;
}

/** A dial that lost its race against the timeout must not leak a live socket. */
const discardLateDial = async (
	pending: Promise<TransportConnection>
): Promise<void> => {
	try {
		const connection = await pending;
		await connection.close();
	} catch {
		// A dial that eventually fails has no connection to clean up.
	}
};

const parseUrl = (url: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new InvalidTransportUrlError(url);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new InvalidTransportUrlError(url);
	}
	return parsed.toString();
};

/**
 * Opens the Host's half of the pipe: an already-addressed dialer that mints one
 * authenticated connection per `dial()`. Outbound only — this half never listens.
 */
export const openWsDialer = (options: WsDialerOptions): WsDialer => {
	const url = parseUrl(options.url);
	const key = loadSigningKey(options.secretKeyHex);
	const dialTimeoutMs = options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
	const connections = new Set<WsTransportConnection>();
	let closed = false;

	const handshake = async (): Promise<TransportConnection> => {
		const channel = new WsChannel(
			new WebSocket(url) as unknown as WebSocketLike
		);
		try {
			await channel.whenOpen();
			const remoteId = await authenticate(channel, key);
			if (remoteId === key.publicKeyHex) {
				throw new SelfDialError();
			}
			const connection: WsTransportConnection = new WsTransportConnection(
				channel,
				remoteId,
				() => connections.delete(connection)
			);
			connections.add(connection);
			return connection;
		} catch (error) {
			await channel.close();
			throw error;
		}
	};

	return {
		close: async () => {
			closed = true;
			await Promise.all([...connections].map((one) => one.close()));
			connections.clear();
		},
		dial: async () => {
			if (closed) {
				throw new Error("Transport dialer is closed.");
			}
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(
				() => timeout.reject(new DialTimeoutError(dialTimeoutMs)),
				dialTimeoutMs
			);
			const pending = handshake();
			try {
				return await Promise.race([pending, timeout.promise]);
			} catch (error) {
				if (error instanceof DialTimeoutError) {
					void discardLateDial(pending);
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		},
		localId: key.publicKeyHex,
		url,
	};
};
