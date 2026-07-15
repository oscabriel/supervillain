/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { actorFromSshEd25519Blob } from "../src/index.js";

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
