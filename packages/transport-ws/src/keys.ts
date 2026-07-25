import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from(
	"302e020100300506032b657004220420",
	"hex"
);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX_KEY = /^[0-9a-f]{64}$/u;

const publicKeyFromHex = (publicKeyHex: string): KeyObject =>
	createPublicKey({
		format: "der",
		key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]),
		type: "spki",
	});

/** An ed25519 identity loaded from its 32-byte seed — key-as-account on the wire. */
export interface SigningKey {
	/** 64 lowercase hex chars. */
	readonly publicKeyHex: string;
	readonly sign: (message: Uint8Array) => Uint8Array;
}

/** Loads a signing key from 64 lowercase hex chars (an ed25519 seed). */
export const loadSigningKey = (secretKeyHex: string): SigningKey => {
	if (!HEX_KEY.test(secretKeyHex)) {
		throw new Error("secretKeyHex must be 64 lowercase hex chars.");
	}
	const privateKey = createPrivateKey({
		format: "der",
		key: Buffer.concat([
			PKCS8_ED25519_PREFIX,
			Buffer.from(secretKeyHex, "hex"),
		]),
		type: "pkcs8",
	});
	const jwk = createPublicKey(privateKey).export({ format: "jwk" });
	if (typeof jwk.x !== "string") {
		throw new TypeError("ed25519 key did not expose raw public material.");
	}
	return {
		publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
		sign: (message) => sign(null, message, privateKey),
	};
};

/** True when `signature` is `publicKeyHex`'s ed25519 signature over `message`. */
export const verifySignature = (
	publicKeyHex: string,
	message: Uint8Array,
	signature: Uint8Array
): boolean => {
	if (!HEX_KEY.test(publicKeyHex)) {
		return false;
	}
	try {
		return verify(null, message, publicKeyFromHex(publicKeyHex), signature);
	} catch {
		return false;
	}
};
