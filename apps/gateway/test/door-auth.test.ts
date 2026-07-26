/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { utils } from "ssh2";

import {
	actorFromIdentity,
	admitsPublicKey,
	roomNameFromIdentity,
} from "../src/door-auth.js";

/** The raw `ssh-ed25519` blob an SSH client offers — what the library hands the
 * admission policy once the signature has verified. */
const ed25519Blob = (): Buffer => {
	const pair = utils.generateKeyPairSync("ed25519");
	const parsed = utils.parseKey(pair.private);
	if (parsed instanceof Error || Array.isArray(parsed)) {
		throw new TypeError("could not generate a test key");
	}
	return parsed.getPublicSSH();
};

const rsaBlob = (): Buffer => {
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { format: "pem", type: "pkcs1" },
		publicKeyEncoding: { format: "pem", type: "pkcs1" },
	});
	const parsed = utils.parseKey(pair.privateKey);
	if (parsed instanceof Error || Array.isArray(parsed)) {
		throw new TypeError("could not generate a test key");
	}
	return parsed.getPublicSSH();
};

describe("the door's public-key admission policy", () => {
	test("an unknown ed25519 key is admitted — first contact is enrolment enough", () => {
		expect(admitsPublicKey({ publicKey: { blob: ed25519Blob() } })).toBe(true);
	});

	test("two different keys are both admitted, as different identities", () => {
		const first = ed25519Blob();
		const second = ed25519Blob();
		expect(admitsPublicKey({ publicKey: { blob: first } })).toBe(true);
		expect(admitsPublicKey({ publicKey: { blob: second } })).toBe(true);
		expect(
			actorFromIdentity({
				method: "publickey",
				publicKey: { blob: first },
				username: "room",
			})
		).not.toBe(
			actorFromIdentity({
				method: "publickey",
				publicKey: { blob: second },
				username: "room",
			})
		);
	});

	test("a key we cannot derive an actor from is refused, not seated", () => {
		expect(admitsPublicKey({ publicKey: { blob: rsaBlob() } })).toBe(false);
		expect(
			admitsPublicKey({ publicKey: { blob: Buffer.from("nonsense") } })
		).toBe(false);
	});
});

describe("the actor a session stamps envelopes with", () => {
	test("a keyed session's actor is its key, in hex", () => {
		const blob = ed25519Blob();
		const actor = actorFromIdentity({
			method: "publickey",
			publicKey: { blob },
			username: "room",
		});
		expect(actor).toMatch(/^[0-9a-f]{64}$/u);
		expect(actor).toBe(blob.subarray(-32).toString("hex"));
	});

	test("the keyless door mints nothing here — guests mint at room entry", () => {
		expect(
			actorFromIdentity({ method: "keyboard-interactive", username: "room" })
		).toBeUndefined();
		expect(
			actorFromIdentity({ method: "none", username: "room" })
		).toBeUndefined();
	});

	test("the ssh username is the room, and carries no authority", () => {
		expect(
			roomNameFromIdentity({
				method: "keyboard-interactive",
				username: "kitchen",
			})
		).toBe("kitchen");
	});
});
