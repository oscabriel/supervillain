import { generateKeyPairSync } from "node:crypto";

const testHarness = process.versions.bun
	? await import("bun:test")
	: await import("vitest");
export const { describe, expect, test } = testHarness;

export interface TestIdentity {
	readonly publicKeyHex: string;
	readonly secretKeyHex: string;
}

/** Mints an ed25519 identity in the same raw-hex shape `@supervillain/identity`
 * persists, without dragging that package into the transport's test lane. */
export const generateIdentity = (): TestIdentity => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicJwk = publicKey.export({ format: "jwk" });
	const privateJwk = privateKey.export({ format: "jwk" });
	if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
		throw new TypeError("Generated ed25519 key did not expose raw material.");
	}
	return {
		publicKeyHex: Buffer.from(publicJwk.x, "base64url").toString("hex"),
		secretKeyHex: Buffer.from(privateJwk.d, "base64url").toString("hex"),
	};
};
