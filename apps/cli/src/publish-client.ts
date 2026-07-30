import { createPrivateKey, sign } from "node:crypto";

import type {
	SnapshotArtifactType,
	SnapshotDocumentV1,
} from "@supervillain/core";
import type { Identity } from "@supervillain/identity";

import { PublishHttpError } from "./publish-http-error.js";
import { PublishNetworkError } from "./publish-network-error.js";

export { PublishHttpError } from "./publish-http-error.js";
export { PublishNetworkError } from "./publish-network-error.js";

const AUTH_DOMAIN = "supervillain/publish-http/1\n";
const HEX_CHALLENGE = /^[0-9a-f]{64}$/u;

export interface PublishedArtifactSummary {
	readonly name: string;
	readonly publishedAt: string;
	readonly type: SnapshotArtifactType;
	readonly url: string;
}

export interface PublishResult {
	readonly publishedAt: string;
	readonly url: string;
}

const privateKeyFrom = (identity: Identity) =>
	createPrivateKey({
		format: "jwk",
		key: {
			crv: "Ed25519",
			d: Buffer.from(identity.secretKeyHex, "hex").toString("base64url"),
			kty: "OKP",
			x: Buffer.from(identity.publicKeyHex, "hex").toString("base64url"),
		},
	});

const responseBody = async (response: Response): Promise<unknown> => {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
};

const requireRecord = (
	value: unknown,
	message: string
): Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Readonly<Record<string, unknown>>;
};

const publishFetch = async (
	input: string | URL,
	init?: RequestInit
): Promise<Response> => {
	try {
		return await fetch(input, init);
	} catch (error) {
		throw new PublishNetworkError(error);
	}
};

const isArtifactSummary = (value: unknown): value is PublishedArtifactSummary =>
	typeof value === "object" &&
	value !== null &&
	"name" in value &&
	typeof value.name === "string" &&
	"publishedAt" in value &&
	typeof value.publishedAt === "string" &&
	"type" in value &&
	(value.type === "character" ||
		value.type === "log" ||
		value.type === "map") &&
	"url" in value &&
	typeof value.url === "string";

export class PublishClient {
	readonly #baseUrl: URL;
	readonly #identity: Identity;

	constructor(baseUrl: string, identity: Identity) {
		this.#baseUrl = new URL(baseUrl);
		this.#identity = identity;
	}

	async #authenticatedFetch(init?: RequestInit): Promise<Response> {
		const challengeResponse = await publishFetch(
			new URL("/api/publish/challenge", this.#baseUrl),
			{
				body: JSON.stringify({ key: this.#identity.publicKeyHex }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}
		);
		const challengeBody = await responseBody(challengeResponse);
		if (!challengeResponse.ok) {
			throw new PublishHttpError(challengeResponse.status, challengeBody);
		}
		const challengeRecord = requireRecord(
			challengeBody,
			"Publish service returned an invalid challenge."
		);
		const { challenge } = challengeRecord;
		if (typeof challenge !== "string" || !HEX_CHALLENGE.test(challenge)) {
			throw new TypeError("Publish service returned an invalid challenge.");
		}
		const message = Buffer.from(
			`${AUTH_DOMAIN}${challenge}\n${this.#identity.publicKeyHex}`
		);
		const signature = sign(
			null,
			message,
			privateKeyFrom(this.#identity)
		).toString("hex");
		const headers = new Headers(init?.headers);
		headers.set("supervillain-key", this.#identity.publicKeyHex);
		headers.set("supervillain-challenge", challenge);
		headers.set("supervillain-signature", signature);
		return await publishFetch(new URL("/api/publish", this.#baseUrl), {
			...init,
			headers,
		});
	}

	async publish(options: {
		readonly document: SnapshotDocumentV1;
		readonly name: string;
		readonly type: SnapshotArtifactType;
	}): Promise<PublishResult> {
		const response = await this.#authenticatedFetch({
			body: JSON.stringify(options),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const body = await responseBody(response);
		if (!response.ok) {
			throw new PublishHttpError(response.status, body);
		}
		const record = requireRecord(
			body,
			"Publish service returned an invalid publish response."
		);
		if (
			typeof record.url !== "string" ||
			typeof record.publishedAt !== "string"
		) {
			throw new TypeError(
				"Publish service returned an invalid publish response."
			);
		}
		return { publishedAt: record.publishedAt, url: record.url };
	}

	async list(): Promise<readonly PublishedArtifactSummary[]> {
		const response = await this.#authenticatedFetch();
		const body = await responseBody(response);
		if (!response.ok) {
			throw new PublishHttpError(response.status, body);
		}
		const record = requireRecord(
			body,
			"Publish service returned an invalid list response."
		);
		if (
			!Array.isArray(record.artifacts) ||
			!record.artifacts.every(isArtifactSummary)
		) {
			throw new TypeError("Publish service returned an invalid list response.");
		}
		return record.artifacts;
	}

	async revoke(options: {
		readonly capability?: string;
		readonly name: string;
		readonly type: SnapshotArtifactType;
	}): Promise<string> {
		const response = await this.#authenticatedFetch({
			body: JSON.stringify(options),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		});
		const body = await responseBody(response);
		if (!response.ok) {
			throw new PublishHttpError(response.status, body);
		}
		const record = requireRecord(
			body,
			"Publish service returned an invalid revoke response."
		);
		if (typeof record.message !== "string") {
			throw new TypeError(
				"Publish service returned an invalid revoke response."
			);
		}
		return record.message;
	}
}
