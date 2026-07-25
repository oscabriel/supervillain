/* oxlint-disable eslint/max-classes-per-file -- the WS transport's dial errors share one public error-contract module. */

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
