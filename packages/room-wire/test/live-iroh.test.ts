/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, promise/avoid-new, eslint/no-promise-executor-return -- dual-lane live-iroh fixture exposes async RoomStore methods and a deliberately pending stream. */
import { generateKeyPairSync } from "node:crypto";

import type { Envelope, RoomCommand, RoomStore } from "@supervillain/core";
import { openIrohEndpoint } from "@supervillain/transport-iroh";

import { connectRoomStore, serveRoomStore } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

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

const nextEnvelope = async (
	iterator: AsyncIterator<Envelope>
): Promise<Envelope> => {
	const result = await iterator.next();
	if (result.done === true) {
		throw new Error("RoomStore stream ended early.");
	}
	return result.value;
};

class LiveStore implements RoomStore {
	readonly #envelopes: Envelope[] = [
		{
			actor: "host",
			payload: { gameId: "test" },
			seq: 1,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "core.room-created",
		},
	];

	async submit(command: RoomCommand) {
		const envelope: Envelope = {
			actor: command.actor,
			payload: command.command,
			seq: this.#envelopes.length + 1,
			timestamp: "2026-01-01T00:00:01.000Z",
			type: "test.commanded",
		};
		this.#envelopes.push(envelope);
		return { accepted: true as const, envelopes: [envelope] };
	}

	stream(fromSeq: number): AsyncIterable<Envelope> {
		const envelopes = this.#envelopes;
		return {
			async *[Symbol.asyncIterator]() {
				for (const envelope of envelopes) {
					if (envelope.seq >= fromSeq) {
						yield envelope;
					}
				}
				await new Promise(() => {});
			},
		};
	}
}

describe("RoomStore wire over live iroh", () => {
	test("authenticates submit and resumes a client stream from mid-Log", async () => {
		const hostIdentity = generateIdentity();
		const clientIdentity = generateIdentity();
		const hostEndpoint = await openIrohEndpoint({
			secretKeyHex: hostIdentity.secretKeyHex,
		});
		const clientEndpoint = await openIrohEndpoint({
			secretKeyHex: clientIdentity.secretKeyHex,
		});
		const server = serveRoomStore(hostEndpoint, new LiveStore(), {
			info: { gameId: "test", label: "Live Room" },
		});
		const remote = await connectRoomStore(
			clientEndpoint,
			hostEndpoint.address,
			{
				reconnectDelayMs: () => 1,
			}
		);
		try {
			expect(
				await remote.submit({
					actor: clientIdentity.publicKeyHex,
					command: { text: "hello" },
				})
			).toMatchObject({ accepted: true, envelopes: [{ seq: 2 }] });

			const initial = remote.stream(1)[Symbol.asyncIterator]();
			expect(await nextEnvelope(initial)).toMatchObject({ seq: 1 });
			await initial.return?.();

			const resumed = remote.stream(2)[Symbol.asyncIterator]();
			expect(await nextEnvelope(resumed)).toMatchObject({
				actor: clientIdentity.publicKeyHex,
				seq: 2,
			});
			await resumed.return?.();
		} finally {
			await remote.close();
			await server.close();
			await clientEndpoint.close();
			await hostEndpoint.close();
		}
	}, 60_000);
});
