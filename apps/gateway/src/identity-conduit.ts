import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { IdentityDirectory } from "@supervillain/identity";

const LOOPBACK_HOST = "127.0.0.1";
const RESOLVE_PATH = "/identity/resolve";
const MAX_REQUEST_BYTES = 4096;
const HEX_KEY = /^[0-9a-f]{64}$/u;

export interface ConduitIdentityDirectory extends IdentityDirectory {
	/** Current identity first, followed by identity ids this key formerly owned.
	 * The lineage preserves backend artifact ownership across ADR-0005's lone-key
	 * move without making the gateway aware of published artifacts. */
	readonly ownerIdentitiesOf: (key: string) => readonly string[];
}

export interface IdentityConduitOptions {
	readonly directory: ConduitIdentityDirectory;
	readonly port: number;
}

export interface RunningIdentityConduit {
	readonly url: string;
	readonly close: () => Promise<void>;
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > MAX_REQUEST_BYTES) {
			throw new Error("identity conduit request is too large");
		}
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
};

const sendJson = (
	response: ServerResponse,
	status: number,
	body: unknown
): void => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};

const isResolveBody = (value: unknown): value is { readonly key: string } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	"key" in value &&
	typeof value.key === "string" &&
	HEX_KEY.test(value.key);

const handleRequest = async (
	request: IncomingMessage,
	response: ServerResponse,
	directory: ConduitIdentityDirectory
): Promise<void> => {
	if (request.method !== "POST" || request.url !== RESOLVE_PATH) {
		sendJson(response, 404, { error: "not found" });
		return;
	}
	let body: unknown;
	try {
		body = await readJson(request);
	} catch {
		sendJson(response, 400, { error: "request must be JSON" });
		return;
	}
	if (!isResolveBody(body)) {
		sendJson(response, 400, { error: "key must be 64 lowercase hex chars" });
		return;
	}
	const ownerIdentityIds = directory.ownerIdentitiesOf(body.key);
	sendJson(response, 200, {
		identityId: directory.identityOf(body.key) ?? null,
		ownerIdentityIds,
		revoked: directory.isRevoked(body.key),
	});
};

/**
 * Starts ADR-0013's hosted-web identity hop. The bind is not configurable on
 * purpose: this is a same-box conduit, never a public gateway HTTP surface.
 */
export const startIdentityConduit = async (
	options: IdentityConduitOptions
): Promise<RunningIdentityConduit> => {
	const server = createServer((request, response) => {
		const serve = async (): Promise<void> => {
			try {
				await handleRequest(request, response, options.directory);
			} catch {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				sendJson(response, 500, { error: "identity conduit failed" });
			}
		};
		void serve();
	});
	// oxlint-disable-next-line promise/avoid-new -- node:http binding is callback/event based.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, LOOPBACK_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("identity conduit did not bind a TCP address");
	}
	return {
		close: () =>
			// oxlint-disable-next-line promise/avoid-new -- node:http close completion is callback based.
			new Promise<void>((resolve, reject) => {
				// oxlint-disable-next-line promise/prefer-await-to-callbacks -- node:http exposes close completion only by callback.
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
		url: `http://${LOOPBACK_HOST}:${address.port}`,
	};
};
