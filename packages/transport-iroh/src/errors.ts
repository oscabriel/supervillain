/* oxlint-disable eslint/max-classes-per-file -- transport dial errors share one public error-contract module. */
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
