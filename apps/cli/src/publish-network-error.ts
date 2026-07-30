export class PublishNetworkError extends Error {
	constructor(cause: unknown) {
		super("Could not reach the publish service.", { cause });
		this.name = "PublishNetworkError";
	}
}
