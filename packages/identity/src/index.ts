import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

/** SSH's length-prefixed string: a big-endian uint32 then the bytes. */
const sshString = (value: Uint8Array | string): Buffer => {
	const bytes =
		typeof value === "string"
			? Buffer.from(value, "utf-8")
			: Buffer.from(value);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.byteLength);
	return Buffer.concat([length, bytes]);
};

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "binary");
/** The `none` cipher's block size — what the private section is padded to. */
const OPENSSH_UNENCRYPTED_BLOCK = 8;
const PEM_LINE_LENGTH = 70;
const PEM_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const PEM_FOOTER = "-----END OPENSSH PRIVATE KEY-----";
/** The comment baked into the exported key — it is per-machine, not per-user. */
const KEY_COMMENT = "supervillain";

const wrapPem = (body: string): string => {
	const lines: string[] = [];
	for (let at = 0; at < body.length; at += PEM_LINE_LENGTH) {
		lines.push(body.slice(at, at + PEM_LINE_LENGTH));
	}
	return `${PEM_HEADER}\n${lines.join("\n")}\n${PEM_FOOTER}\n`;
};

/**
 * Re-encodes the per-machine identity as an unencrypted OpenSSH ed25519 private
 * key, so an ordinary `ssh` client can present it at the gateway's door.
 *
 * This is a re-encoding, never a second credential: the same key that
 * authenticates the Host pipe is the key the player sits down with, which is
 * what "the CLI is tooling, not a membership card" means in practice
 * (ADR-0012, NQ-7). The output is deterministic — the checkint is derived from
 * the public key rather than drawn at random — so rewriting the file is a
 * no-op the moment it already matches.
 */
export const openSshPrivateKey = (identity: Identity): string => {
	if (
		!(
			HEX_KEY.test(identity.publicKeyHex) && HEX_KEY.test(identity.secretKeyHex)
		)
	) {
		throw new Error("Identity does not hold raw ed25519 key material.");
	}
	const publicKey = Buffer.from(identity.publicKeyHex, "hex");
	// OpenSSH's ed25519 "private key" is the seed followed by the public key.
	const privateKey = Buffer.concat([
		Buffer.from(identity.secretKeyHex, "hex"),
		publicKey,
	]);
	const publicBlob = Buffer.concat([
		sshString(SSH_ED25519),
		sshString(publicKey),
	]);
	const checkint = publicKey.subarray(0, 4);
	const body = Buffer.concat([
		checkint,
		checkint,
		sshString(SSH_ED25519),
		sshString(publicKey),
		sshString(privateKey),
		sshString(KEY_COMMENT),
	]);
	const padLength =
		(OPENSSH_UNENCRYPTED_BLOCK -
			(body.byteLength % OPENSSH_UNENCRYPTED_BLOCK)) %
		OPENSSH_UNENCRYPTED_BLOCK;
	const padding = Buffer.from(
		Array.from({ length: padLength }, (_value, index) => index + 1)
	);
	const container = Buffer.concat([
		OPENSSH_MAGIC,
		sshString("none"),
		sshString("none"),
		sshString(""),
		Buffer.from([0, 0, 0, 1]),
		sshString(publicBlob),
		sshString(Buffer.concat([body, padding])),
	]);
	return wrapPem(container.toString("base64"));
};

/** The `authorized_keys` / `known_hosts` form of the same public key. */
export const openSshPublicKeyLine = (identity: Identity): string => {
	if (!HEX_KEY.test(identity.publicKeyHex)) {
		throw new Error("Identity does not hold a raw ed25519 public key.");
	}
	const publicBlob = Buffer.concat([
		sshString(SSH_ED25519),
		sshString(Buffer.from(identity.publicKeyHex, "hex")),
	]);
	return `${SSH_ED25519} ${publicBlob.toString("base64")} ${KEY_COMMENT}`;
};

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
