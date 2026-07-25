import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type { IdentityDirectory } from "./directory.js";

export interface Identity {
	readonly publicKeyHex: string;
	readonly secretKeyHex: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/u;

const SSH_ED25519 = "ssh-ed25519";
const SSH_ED25519_BLOB_LENGTH = 4 + SSH_ED25519.length + 4 + 32;

/** Extracts the actor string (64 lowercase hex chars) from an SSH wire-format
 * `ssh-ed25519` public-key blob — key-as-account at the SSH door. Returns
 * undefined for anything that is not exactly an ed25519 public key. */
export const actorFromSshEd25519Blob = (
	blob: Uint8Array
): string | undefined => {
	if (blob.byteLength !== SSH_ED25519_BLOB_LENGTH) {
		return undefined;
	}
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	if (view.getUint32(0) !== SSH_ED25519.length) {
		return undefined;
	}
	const algo = new TextDecoder().decode(
		blob.subarray(4, 4 + SSH_ED25519.length)
	);
	if (algo !== SSH_ED25519) {
		return undefined;
	}
	if (view.getUint32(4 + SSH_ED25519.length) !== 32) {
		return undefined;
	}
	return Buffer.from(blob.subarray(SSH_ED25519_BLOB_LENGTH - 32)).toString(
		"hex"
	);
};

const decodeBase64Url = (value: string): string =>
	Buffer.from(value, "base64url").toString("hex");

const validateIdentity = (value: unknown, file: string): Identity => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("publicKeyHex" in value) ||
		!("secretKeyHex" in value) ||
		typeof value.publicKeyHex !== "string" ||
		typeof value.secretKeyHex !== "string" ||
		!HEX_KEY.test(value.publicKeyHex) ||
		!HEX_KEY.test(value.secretKeyHex)
	) {
		throw new Error(
			`Identity file '${file}' does not contain valid ed25519 keys.`
		);
	}
	return {
		publicKeyHex: value.publicKeyHex,
		secretKeyHex: value.secretKeyHex,
	};
};

const loadIdentity = async (file: string): Promise<Identity | undefined> => {
	let bytes: string;
	try {
		bytes = await readFile(file, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	try {
		return validateIdentity(JSON.parse(bytes), file);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new TypeError(`Identity file '${file}' is not valid JSON.`, {
				cause: error,
			});
		}
		throw error;
	}
};

export const loadOrCreateIdentity = async (
	folder: string
): Promise<Identity> => {
	const file = path.join(folder, "identity.json");
	const existing = await loadIdentity(file);
	if (existing !== undefined) {
		return existing;
	}

	await mkdir(folder, { recursive: true });
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicJwk = publicKey.export({ format: "jwk" });
	const privateJwk = privateKey.export({ format: "jwk" });
	if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
		throw new TypeError(
			"Generated ed25519 identity did not expose raw key material."
		);
	}
	const identity: Identity = {
		publicKeyHex: decodeBase64Url(publicJwk.x),
		secretKeyHex: decodeBase64Url(privateJwk.d),
	};
	await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return identity;
};
