/**
 * The transport seam. `room-wire` owns it and imports no transport package
 * (ADR-0012, NQ-13): adapters implement these three types, the wire protocol
 * speaks only to them.
 *
 * The interface serves exactly one live transport at launch and fits it
 * snugly — there is no route kind, no ticket blob, and no relay hint here.
 */

/** A framed, bidirectional message connection between two authenticated peers. */
export interface TransportConnection {
	/** The peer's ed25519 public key as 64 lowercase hex chars — the actor string. */
	readonly remoteId: string;
	readonly send: (message: Uint8Array) => Promise<void>;
	readonly receive: () => Promise<Uint8Array>;
	readonly close: () => Promise<void>;
}

/**
 * Opens fresh connections to one peer. A dialer is already addressed — where
 * it dials, and in what form that address was written down, is the adapter's
 * business and never the wire protocol's.
 */
export interface TransportDialer {
	readonly dial: () => Promise<TransportConnection>;
}

/** Accepts inbound connections until closed. */
export interface TransportListener {
	/** Rejects with {@link TransportListenerClosedError} once closed. */
	readonly accept: () => Promise<TransportConnection>;
	readonly close: () => Promise<void>;
}

/** Ends an accept loop without recording a failure: the listener shut down. */
export class TransportListenerClosedError extends Error {
	constructor() {
		super("Transport listener closed while accepting.");
		this.name = "TransportListenerClosedError";
	}
}
