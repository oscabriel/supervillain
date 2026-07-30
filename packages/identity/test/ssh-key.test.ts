/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	actorFromSshEd25519Blob,
	fingerprintFromActor,
	loadOrCreateIdentity,
	openSshPrivateKey,
	openSshPublicKeyLine,
} from "../src/index.js";
import type { Identity } from "../src/index.js";

const SSH_ED25519 = "ssh-ed25519";

const sshBlob = (algo: string, keyBytes: Uint8Array): Uint8Array => {
	const algoBytes = new TextEncoder().encode(algo);
	const blob = new Uint8Array(4 + algoBytes.length + 4 + keyBytes.length);
	const view = new DataView(blob.buffer);
	view.setUint32(0, algoBytes.length);
	blob.set(algoBytes, 4);
	view.setUint32(4 + algoBytes.length, keyBytes.length);
	blob.set(keyBytes, 4 + algoBytes.length + 4);
	return blob;
};

const rawEd25519PublicKey = (): { hex: string; bytes: Uint8Array } => {
	const { publicKey } = generateKeyPairSync("ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	if (typeof jwk.x !== "string") {
		throw new TypeError("Generated key did not expose raw material.");
	}
	const bytes = Uint8Array.from(Buffer.from(jwk.x, "base64url"));
	return { bytes, hex: Buffer.from(bytes).toString("hex") };
};

describe("fingerprintFromActor", () => {
	test("formats the OpenSSH SHA256 fingerprint of an actor key", () => {
		expect(fingerprintFromActor("00".repeat(32))).toBe(
			"SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"
		);
	});

	test("refuses guest actors and malformed key actors", () => {
		expect(fingerprintFromActor("guest:abc123def456")).toBeUndefined();
		expect(fingerprintFromActor("not-a-key")).toBeUndefined();
	});
});

describe("actorFromSshEd25519Blob", () => {
	test("extracts the actor hex from a wire-format ssh-ed25519 blob", () => {
		const key = rawEd25519PublicKey();
		expect(actorFromSshEd25519Blob(sshBlob(SSH_ED25519, key.bytes))).toBe(
			key.hex
		);
	});

	test("returns undefined for non-ed25519 algos and malformed blobs", () => {
		const key = rawEd25519PublicKey();
		expect(actorFromSshEd25519Blob(sshBlob("ssh-rsa", key.bytes))).toBe(
			undefined
		);
		expect(
			actorFromSshEd25519Blob(sshBlob(SSH_ED25519, key.bytes.subarray(1)))
		).toBe(undefined);
		expect(actorFromSshEd25519Blob(new Uint8Array(0))).toBe(undefined);
		const truncatedAlgoLength = sshBlob(SSH_ED25519, key.bytes);
		new DataView(truncatedAlgoLength.buffer).setUint32(0, 10);
		expect(actorFromSshEd25519Blob(truncatedAlgoLength)).toBe(undefined);
	});

	test("reads blobs at a nonzero byte offset", () => {
		const key = rawEd25519PublicKey();
		const blob = sshBlob(SSH_ED25519, key.bytes);
		const padded = new Uint8Array(blob.length + 8);
		padded.set(blob, 8);
		expect(actorFromSshEd25519Blob(padded.subarray(8))).toBe(key.hex);
	});
});

const PEM_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const PEM_FOOTER = "-----END OPENSSH PRIVATE KEY-----";

/** Walks the length-prefixed fields of an OpenSSH key container back out. */
class SshReader {
	#at = 0;
	readonly #bytes: Buffer;

	constructor(bytes: Buffer) {
		this.#bytes = bytes;
	}

	take(length: number): Buffer {
		const slice = this.#bytes.subarray(this.#at, this.#at + length);
		this.#at += length;
		return slice;
	}

	string(): Buffer {
		const length = this.#bytes.readUInt32BE(this.#at);
		this.#at += 4;
		return this.take(length);
	}

	rest(): Buffer {
		return this.#bytes.subarray(this.#at);
	}
}

const decodePem = (pem: string): Buffer => {
	const lines = pem.trim().split("\n");
	expect(lines.at(0)).toBe(PEM_HEADER);
	expect(lines.at(-1)).toBe(PEM_FOOTER);
	return Buffer.from(lines.slice(1, -1).join(""), "base64");
};

const identityFrom = async (): Promise<Identity> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-ssh-key-"));
	try {
		return await loadOrCreateIdentity(folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

describe("openSshPrivateKey", () => {
	test("re-encodes the identity as an unencrypted OpenSSH ed25519 key", async () => {
		const identity = await identityFrom();
		const reader = new SshReader(decodePem(openSshPrivateKey(identity)));
		expect(reader.take(15).toString("binary")).toBe("openssh-key-v1\0");
		expect(reader.string().toString()).toBe("none");
		expect(reader.string().toString()).toBe("none");
		expect(reader.string()).toHaveLength(0);
		expect(reader.take(4).readUInt32BE(0)).toBe(1);

		const publicBlob = reader.string();
		expect(actorFromSshEd25519Blob(publicBlob)).toBe(identity.publicKeyHex);

		const body = new SshReader(reader.string());
		expect(reader.rest()).toHaveLength(0);
		const checkOne = body.take(4);
		expect(body.take(4)).toEqual(checkOne);
		expect(body.string().toString()).toBe(SSH_ED25519);
		expect(body.string().toString("hex")).toBe(identity.publicKeyHex);
		// OpenSSH's ed25519 private half is seed || public key.
		expect(body.string().toString("hex")).toBe(
			`${identity.secretKeyHex}${identity.publicKeyHex}`
		);
		expect(body.string().toString()).toBe("supervillain");
	});

	test("pads the private section to the cipher block and stays deterministic", async () => {
		const identity = await identityFrom();
		const pem = openSshPrivateKey(identity);
		expect(openSshPrivateKey(identity)).toBe(pem);
		const reader = new SshReader(decodePem(pem));
		reader.take(15);
		reader.string();
		reader.string();
		reader.string();
		reader.take(4);
		reader.string();
		expect(reader.string().byteLength % 8).toBe(0);
	});

	test("refuses an identity that is not raw ed25519 material", () => {
		expect(() =>
			openSshPrivateKey({ publicKeyHex: "nope", secretKeyHex: "nope" })
		).toThrow("Identity does not hold raw ed25519 key material.");
		expect(() =>
			openSshPublicKeyLine({ publicKeyHex: "", secretKeyHex: "" })
		).toThrow("Identity does not hold a raw ed25519 public key.");
	});
});

describe("openSshPublicKeyLine", () => {
	test("prints the authorized_keys form of the same key", async () => {
		const identity = await identityFrom();
		const [algo, encoded, comment] = openSshPublicKeyLine(identity).split(" ");
		expect(algo).toBe(SSH_ED25519);
		expect(comment).toBe("supervillain");
		expect(actorFromSshEd25519Blob(Buffer.from(encoded ?? "", "base64"))).toBe(
			identity.publicKeyHex
		);
	});
});
