export class PublishHttpError extends Error {
	readonly body: unknown;
	readonly status: number;

	constructor(status: number, body: unknown) {
		super(`Publish service answered HTTP ${status}.`);
		this.name = "PublishHttpError";
		this.body = body;
		this.status = status;
	}
}
