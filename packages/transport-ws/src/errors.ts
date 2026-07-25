/* oxlint-disable eslint/max-classes-per-file -- the WS transport's dial errors share one public error-contract module. */
import { TransportTrustError } from "@supervillain/room-wire";

export class DialTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Dial timed out after ${timeoutMs}ms.`);
		this.name = "DialTimeoutError";
	}
}

export class SelfDialError extends Error {
	constructor() {
		super("Cannot dial this transport endpoint from itself.");
		this.name = "SelfDialError";
	}
}

export class InvalidTransportUrlError extends Error {
	constructor(url: string) {
		super(`Transport address '${url}' is not a ws:// or wss:// URL.`);
		this.name = "InvalidTransportUrlError";
	}
}

/** The challenge-signature exchange did not produce two authenticated peers. */
export class HandshakeError extends Error {
	constructor(reason: string) {
		super(`Transport handshake failed: ${reason}`);
		this.name = "HandshakeError";
	}
}

/** A pairing code that is a URL but carries something other than a fingerprint
 * where a fingerprint belongs. */
export class InvalidPairingCodeError extends Error {
	constructor(reason: string) {
		super(`Gateway pairing code is invalid: ${reason}`);
		this.name = "InvalidPairingCodeError";
	}
}

/**
 * The gateway served a certificate other than the pinned one. This is the whole
 * value of trust on first use, so it is a refusal and never a prompt: the
 * message names both fingerprints so a human can tell a deliberate rotation
 * from an impostor.
 */
export class CertificateMismatchError extends TransportTrustError {
	readonly expected: string;
	readonly served: string;
	readonly url: string;

	constructor(url: string, expected: string, served: string) {
		super(
			`Refused: the gateway at ${url} served a certificate this machine has not pinned.\n  pinned:  ${expected}\n  served:  ${served}\nA changed certificate means the gateway was rebuilt, or something is impersonating it.`
		);
		this.name = "CertificateMismatchError";
		this.expected = expected;
		this.served = served;
		this.url = url;
	}
}

/** A fingerprint was supplied for a `ws://` address. A fingerprint is a promise
 * about TLS, and there is no TLS on a plaintext socket to check it against. */
export class PlaintextPinError extends Error {
	constructor(url: string) {
		super(
			`Address '${url}' is plaintext, so its certificate fingerprint cannot be checked. A pinned gateway must be dialed over wss://.`
		);
		this.name = "PlaintextPinError";
	}
}
