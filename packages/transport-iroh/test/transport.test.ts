/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite; the harness picks bun:test or vitest at runtime. */
import { generateKeyPairSync } from "node:crypto";

import { openIrohEndpoint } from "../src/index.js";
import type {
	IrohEndpointOptions,
	TransportConnection,
	TransportEndpoint,
} from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const text = new TextEncoder();
const decode = new TextDecoder();

const generateIdentity = (): {
	readonly publicKeyHex: string;
	readonly secretKeyHex: string;
} => {
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

const openPair = async (
	options: IrohEndpointOptions
): Promise<readonly [TransportEndpoint, TransportEndpoint]> => {
	const first = await openIrohEndpoint(options);
	try {
		return [first, await openIrohEndpoint(options)];
	} catch (error) {
		await first.close();
		throw error;
	}
};

const connectPair = async (
	dialing: TransportEndpoint,
	accepting: TransportEndpoint
): Promise<readonly [TransportConnection, TransportConnection]> => {
	const accepted = accepting.accept();
	return [await dialing.dial(accepting.address), await accepted];
};

const exchange = async (
	sender: TransportConnection,
	receiver: TransportConnection,
	message: string
): Promise<void> => {
	await sender.send(text.encode(message));
	expect(decode.decode(await receiver.receive())).toBe(message);
};

const closeAll = async (
	...closeables: readonly { readonly close: () => Promise<void> }[]
): Promise<void> => {
	await Promise.all(closeables.map((closeable) => closeable.close()));
};

describe("iroh transport", () => {
	test("seeds endpoint identities and authenticates both peers", async () => {
		const seededIdentity = generateIdentity();
		const dialerIdentity = generateIdentity();
		const seeded = await openIrohEndpoint({
			routing: "direct",
			secretKeyHex: seededIdentity.secretKeyHex,
		});
		const dialer = await openIrohEndpoint({
			routing: "direct",
			secretKeyHex: dialerIdentity.secretKeyHex,
		});
		try {
			const [outbound, inbound] = await connectPair(dialer, seeded);
			expect(outbound.remoteId).toBe(seededIdentity.publicKeyHex);
			expect(inbound.remoteId).toBe(dialerIdentity.publicKeyHex);
			await closeAll(outbound, inbound);
		} finally {
			await closeAll(dialer, seeded);
		}
	}, 30_000);

	test("rejects malformed seeded endpoint identities", async () => {
		await expect(
			openIrohEndpoint({ secretKeyHex: "A".repeat(64) })
		).rejects.toThrow("secretKeyHex must be 64 lowercase hex chars.");
	});

	test("connects two peers directly and exchanges framed messages", async () => {
		const [first, second] = await openPair({ routing: "direct" });
		try {
			const [outbound, inbound] = await connectPair(first, second);
			expect(outbound.route).toBe("direct");
			expect(inbound.route).toBe("direct");
			await exchange(outbound, inbound, "direct hello");
			await exchange(inbound, outbound, "direct reply");
			await closeAll(outbound, inbound);
		} finally {
			await closeAll(first, second);
		}
	}, 30_000);

	test("connects two peers through a forced relay route", async () => {
		const [first, second] = await openPair({ routing: "relay" });
		try {
			const [outbound, inbound] = await connectPair(first, second);
			expect(outbound.route).toBe("relay");
			expect(inbound.route).toBe("relay");
			await exchange(outbound, inbound, "relay hello");
			await closeAll(outbound, inbound);
		} finally {
			await closeAll(first, second);
		}
	}, 60_000);

	test("redials after a connection drop", async () => {
		const [first, second] = await openPair({ routing: "direct" });
		try {
			const [firstOutbound, firstInbound] = await connectPair(first, second);
			await exchange(firstOutbound, firstInbound, "before drop");
			await closeAll(firstOutbound, firstInbound);

			const [secondOutbound, secondInbound] = await connectPair(first, second);
			await exchange(secondOutbound, secondInbound, "after redial");
			await closeAll(secondOutbound, secondInbound);
		} finally {
			await closeAll(first, second);
		}
	}, 30_000);

	test("shuts connections and endpoints down idempotently", async () => {
		const [first, second] = await openPair({ routing: "direct" });
		const [outbound, inbound] = await connectPair(first, second);
		await exchange(outbound, inbound, "goodbye");

		await closeAll(outbound, inbound);
		await closeAll(outbound, inbound);
		await closeAll(first, second);
		await closeAll(first, second);
	}, 30_000);
});
