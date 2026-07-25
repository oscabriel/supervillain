import { randomBytes } from "node:crypto";

import type { WsChannel } from "./channel.js";
import { HandshakeError } from "./errors.js";
import { verifySignature } from "./keys.js";
import type { SigningKey } from "./keys.js";

/** Wire version of the challenge-signature exchange. Bumping it is a breaking
 * wire change, not a tunable. */
const HANDSHAKE_VERSION = 1;
const DOMAIN = "supervillain/transport-ws/1\n";
const NONCE_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/u;
const HEX_NONCE = /^[0-9a-f]{64}$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Hello {
	readonly id: string;
	readonly nonce: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Frame kind is deliberately not load-bearing: runtimes disagree about whether
// a WebSocket text frame arrives as a string or as bytes, so the handshake reads
// either and decides by protocol position instead.
const parseJson = (message: string | Uint8Array): unknown => {
	try {
		return JSON.parse(
			typeof message === "string" ? message : decoder.decode(message)
		) as unknown;
	} catch {
		throw new HandshakeError("frame was not JSON.");
	}
};

const parseHello = (message: string | Uint8Array): Hello => {
	const value = parseJson(message);
	if (
		!isRecord(value) ||
		value.v !== HANDSHAKE_VERSION ||
		typeof value.id !== "string" ||
		!HEX_KEY.test(value.id) ||
		typeof value.nonce !== "string" ||
		!HEX_NONCE.test(value.nonce)
	) {
		throw new HandshakeError("peer hello is invalid.");
	}
	return { id: value.id, nonce: value.nonce };
};

const parseProof = (message: string | Uint8Array): string => {
	const value = parseJson(message);
	if (
		!isRecord(value) ||
		value.v !== HANDSHAKE_VERSION ||
		typeof value.signature !== "string" ||
		!/^[0-9a-f]+$/u.test(value.signature)
	) {
		throw new HandshakeError("peer proof is invalid.");
	}
	return value.signature;
};

/** What a peer signs: the domain tag, the challenge it was given, and the key
 * it claims. Binding the claimed key stops a signature being replayed under
 * another identity. */
const challenge = (nonce: string, id: string): Uint8Array =>
	encoder.encode(`${DOMAIN}${nonce}\n${id}`);

/**
 * Runs the mutual challenge-signature exchange (ADR-0012, NQ-3) and returns the
 * peer's authenticated identity. Both halves run the identical exchange, so the
 * gateway proves itself to a Host exactly as a Host proves itself to the gateway.
 */
export const authenticate = async (
	channel: WsChannel,
	key: SigningKey
): Promise<string> => {
	const nonce = randomBytes(NONCE_BYTES).toString("hex");
	channel.send(
		encoder.encode(
			JSON.stringify({ id: key.publicKeyHex, nonce, v: HANDSHAKE_VERSION })
		)
	);
	const peer = parseHello(await channel.next());
	channel.send(
		encoder.encode(
			JSON.stringify({
				signature: Buffer.from(
					key.sign(challenge(peer.nonce, key.publicKeyHex))
				).toString("hex"),
				v: HANDSHAKE_VERSION,
			})
		)
	);
	const signature = parseProof(await channel.next());
	if (
		!verifySignature(
			peer.id,
			challenge(nonce, peer.id),
			Buffer.from(signature, "hex")
		)
	) {
		throw new HandshakeError("peer signature did not verify.");
	}
	return peer.id;
};
