/* oxlint-disable promise/avoid-new -- the HTTP and WebSocket servers' listen and close are callback-shaped. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createServer as createTlsServer } from "node:https";

import { TransportListenerClosedError } from "@supervillain/room-wire";
import type {
	TransportConnection,
	TransportListener,
} from "@supervillain/room-wire";
import { WebSocketServer } from "ws";

import { WsChannel } from "./channel.js";
import type { WebSocketLike } from "./channel.js";
import { MAX_MESSAGE_BYTES, WsTransportConnection } from "./connection.js";
import { fingerprintOfPem } from "./fingerprint.js";
import { authenticate } from "./handshake.js";
import { loadSigningKey } from "./keys.js";

export {
	mintSelfSignedCertificate,
	type MintOptions,
	type SelfSignedCertificate,
} from "./certificate.js";
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

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_HOST = "127.0.0.1";

/** The certificate this listener terminates TLS with. Present means the pipe is
 * `wss:` in this process; absent means plaintext — which in production means
 * something in front already terminated it (ADR-0014). */
export interface WsListenerTls {
	readonly certificatePem: string;
	readonly privateKeyPem: string;
}

export interface WsListenerOptions {
	/** 64 lowercase hex chars (ed25519 seed) — the identity this side proves. */
	readonly secretKeyHex: string;
	/** TCP port to bind; 0 takes an ephemeral port. Default: 0. */
	readonly port?: number;
	/** Interface to bind. Default: 127.0.0.1. */
	readonly host?: string;
	/** What peers should dial, when that differs from the bound address. */
	readonly advertisedUrl?: string;
	/** Maximum time in ms a peer may take to finish the handshake. Default: 5000ms. */
	readonly handshakeTimeoutMs?: number;
	/** Terminate TLS here. Omit only when TLS is terminated upstream. */
	readonly tls?: WsListenerTls;
}

export interface WsListener extends TransportListener {
	/** This listener's own identity — 64 lowercase hex chars. */
	readonly localId: string;
	/** The `ws:` or `wss:` URL peers dial to reach this listener. */
	readonly url: string;
	readonly port: number;
	/** The fingerprint of the certificate this listener terminates TLS with, if
	 * it terminates TLS at all — the pinned half of a pairing code. */
	readonly certificateFingerprint: string | undefined;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly reject: (error: unknown) => void;
	readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
	const resolvers = Promise.withResolvers<T>();
	return {
		promise: resolvers.promise,
		reject: resolvers.reject,
		resolve: resolvers.resolve,
	};
};

const boundPort = (server: Server): number => {
	const address = server.address();
	if (typeof address === "string" || address === null) {
		throw new Error("WebSocket listener did not bind a TCP port.");
	}
	return address.port;
};

const timeoutAfter = (
	milliseconds: number,
	message: string
): { readonly promise: Promise<never>; readonly cancel: () => void } => {
	const failed = deferred<never>();
	const timer = setTimeout(
		() => failed.reject(new Error(message)),
		milliseconds
	);
	return {
		cancel: () => clearTimeout(timer),
		promise: failed.promise,
	};
};

/**
 * Opens the gateway's half of the pipe: a listener that authenticates every
 * inbound peer before handing it up as a connection. Gateway-only — the Host
 * dials out (ADR-0012), it does not listen.
 */
export const startWsListener = async (
	options: WsListenerOptions
): Promise<WsListener> => {
	const key = loadSigningKey(options.secretKeyHex);
	const host = options.host ?? DEFAULT_HOST;
	const handshakeTimeoutMs =
		options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	// The HTTP server is ours rather than the WebSocket server's own, because
	// only its owner can force still-upgraded sockets shut on close.
	const httpServer: Server =
		options.tls === undefined
			? createServer()
			: (createTlsServer({
					cert: options.tls.certificatePem,
					key: options.tls.privateKeyPem,
				}) as unknown as Server);
	const server = new WebSocketServer({
		maxPayload: MAX_MESSAGE_BYTES,
		server: httpServer,
	});
	const accepted: TransportConnection[] = [];
	const acceptors: Deferred<TransportConnection>[] = [];
	const connections = new Set<WsTransportConnection>();
	let closed = false;

	const admit = async (socket: WebSocketLike): Promise<void> => {
		const channel = new WsChannel(socket);
		const expiry = timeoutAfter(
			handshakeTimeoutMs,
			"Transport handshake timed out."
		);
		let remoteId: string;
		try {
			remoteId = await Promise.race([
				authenticate(channel, key),
				expiry.promise,
			]);
		} catch {
			await channel.close();
			return;
		} finally {
			expiry.cancel();
		}
		if (closed) {
			await channel.close();
			return;
		}
		const connection: WsTransportConnection = new WsTransportConnection(
			channel,
			remoteId,
			() => connections.delete(connection)
		);
		connections.add(connection);
		const acceptor = acceptors.shift();
		if (acceptor === undefined) {
			accepted.push(connection);
		} else {
			acceptor.resolve(connection);
		}
	};

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port ?? 0, host, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	httpServer.on("error", () => {
		// A listener-level socket error ends that socket, never the listener.
	});
	server.on("error", () => {
		// Same for a failed upgrade: it costs that peer its dial, nothing more.
	});
	server.on("connection", (socket) => {
		void admit(socket as unknown as WebSocketLike);
	});

	const port = boundPort(httpServer);
	let closePromise: Promise<void> | undefined;
	const certificateFingerprint =
		options.tls === undefined
			? undefined
			: fingerprintOfPem(options.tls.certificatePem);
	return {
		accept: () => {
			const next = accepted.shift();
			if (next !== undefined) {
				return Promise.resolve(next);
			}
			if (closed) {
				return Promise.reject(new TransportListenerClosedError());
			}
			const acceptor = deferred<TransportConnection>();
			acceptors.push(acceptor);
			return acceptor.promise;
		},
		certificateFingerprint,
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				closed = true;
				for (const acceptor of acceptors.splice(0)) {
					acceptor.reject(new TransportListenerClosedError());
				}
				await Promise.all(
					[...accepted.splice(0), ...connections].map((one) => one.close())
				);
				// A graceful close frame leaves the socket upgraded for another turn,
				// and neither server reports itself closed while one remains. Drop
				// them outright: every connection has already been told, so nothing
				// is lost here.
				for (const client of server.clients) {
					client.terminate();
				}
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
				httpServer.closeAllConnections();
				await new Promise<void>((resolve) => {
					httpServer.close(() => resolve());
				});
			})();
			return closePromise;
		},
		localId: key.publicKeyHex,
		port,
		url:
			options.advertisedUrl ??
			`${options.tls === undefined ? "ws" : "wss"}://${host}:${port}`,
	};
};
