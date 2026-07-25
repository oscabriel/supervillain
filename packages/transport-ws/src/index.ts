import type {
	TransportConnection,
	TransportDialer,
} from "@supervillain/room-wire";
import { WebSocket as WsClient } from "ws";

import { WsChannel } from "./channel.js";
import type { WebSocketLike } from "./channel.js";
import { WsTransportConnection } from "./connection.js";
import {
	DialTimeoutError,
	InvalidTransportUrlError,
	PlaintextPinError,
	SelfDialError,
} from "./errors.js";
import { normalizeFingerprint } from "./fingerprint.js";
import { authenticate } from "./handshake.js";
import { loadSigningKey } from "./keys.js";
import { certificateForPin } from "./pinning.js";

export { MAX_MESSAGE_BYTES } from "./connection.js";
export {
	CertificateMismatchError,
	DialTimeoutError,
	HandshakeError,
	InvalidPairingCodeError,
	InvalidTransportUrlError,
	PlaintextPinError,
	SelfDialError,
} from "./errors.js";
export {
	FINGERPRINT_ALGORITHM,
	FINGERPRINT_RULE,
	fingerprintOfDer,
	fingerprintOfPem,
	formatPairingCode,
	gatewayOrigin,
	normalizeFingerprint,
	parsePairingCode,
} from "./fingerprint.js";
export type { GatewayPairing } from "./fingerprint.js";
export { certificateForPin, readServedCertificate } from "./pinning.js";
export type { ServedCertificate } from "./pinning.js";

const DEFAULT_DIAL_TIMEOUT_MS = 5000;

export interface WsDialerOptions {
	/** The `ws:` or `wss:` URL every dial opens a connection to. */
	readonly url: string;
	/** 64 lowercase hex chars (ed25519 seed) — the identity this side proves. */
	readonly secretKeyHex: string;
	/** Maximum time in ms for one dial, handshake included. Default: 5000ms. */
	readonly dialTimeoutMs?: number;
	/** The certificate this gateway must serve — the pinned half of the pairing
	 * code (ADR-0012, NQ-9). Omit for a gateway with a CA-issued certificate,
	 * which is checked against the machine's trust store instead. */
	readonly certificateFingerprint?: string;
}

export interface WsDialer extends TransportDialer {
	/** This dialer's own identity — 64 lowercase hex chars. */
	readonly localId: string;
	/** The URL this dialer opens connections to. */
	readonly url: string;
	/** The certificate fingerprint every dial insists on, if any. */
	readonly certificateFingerprint: string | undefined;
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

/** The trust the socket is opened with. A pinned gateway is trusted through the
 * certificate the pin just verified and nothing else — not the machine's CA
 * store, and not a waived check. Bun and Node's `ws` read the same options under
 * different names, so both spellings are supplied. */
const tlsOptions = (
	certificatePem: string | undefined
): Record<string, unknown> => {
	if (certificatePem === undefined) {
		return {};
	}
	const trust = {
		ca: certificatePem,
		// There is no domain to check — NQ-9's whole point. Identity is the
		// fingerprint, already verified against the pin above.
		checkServerIdentity: (): undefined => undefined,
	};
	return { ...trust, tls: trust };
};

/**
 * Opens the Host's half of the pipe: an already-addressed dialer that mints one
 * authenticated connection per `dial()`. Outbound only — this half never listens.
 */
export const openWsDialer = (options: WsDialerOptions): WsDialer => {
	const url = parseUrl(options.url);
	const fingerprint =
		options.certificateFingerprint === undefined
			? undefined
			: normalizeFingerprint(options.certificateFingerprint);
	if (options.certificateFingerprint !== undefined) {
		if (fingerprint === undefined) {
			throw new InvalidTransportUrlError(options.certificateFingerprint);
		}
		if (new URL(url).protocol !== "wss:") {
			throw new PlaintextPinError(url);
		}
	}
	const key = loadSigningKey(options.secretKeyHex);
	const dialTimeoutMs = options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
	const connections = new Set<WsTransportConnection>();
	let closed = false;

	const handshake = async (): Promise<TransportConnection> => {
		// Trust is settled before the WebSocket exists: a pinned gateway's
		// certificate is read and compared first, so a wrong certificate costs a
		// bare TLS handshake and nothing of ours is ever sent to it.
		const verified =
			fingerprint === undefined
				? undefined
				: await certificateForPin(url, fingerprint);
		const pinned = verified?.certificatePem;
		const channel = new WsChannel(
			new WsClient(url, tlsOptions(pinned)) as unknown as WebSocketLike
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
		certificateFingerprint: fingerprint,
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
