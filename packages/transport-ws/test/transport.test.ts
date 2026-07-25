/* oxlint-disable vitest/prefer-importing-vitest-globals, promise/avoid-new, eslint/no-await-in-loop -- dual-lane transport suite drives event-shaped sockets and sequential wire exchanges. */
import { createServer } from "node:net";
import type { Socket } from "node:net";

import type { TransportConnection } from "@supervillain/room-wire";
import { TransportListenerClosedError } from "@supervillain/room-wire";

import {
	DialTimeoutError,
	InvalidTransportUrlError,
	MAX_MESSAGE_BYTES,
	openWsDialer,
	SelfDialError,
} from "../src/index.js";
import { startWsListener } from "../src/server.js";
import type { WsListener } from "../src/server.js";
import { describe, expect, generateIdentity, test } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const captureRejection = async (
	promise: Promise<unknown>
): Promise<unknown> => {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
};

interface Peers {
	readonly listener: WsListener;
	readonly hostId: string;
	readonly gatewayId: string;
	readonly dial: () => Promise<TransportConnection>;
	readonly close: () => Promise<void>;
}

const openPeers = async (): Promise<Peers> => {
	const gateway = generateIdentity();
	const host = generateIdentity();
	const listener = await startWsListener({
		secretKeyHex: gateway.secretKeyHex,
	});
	const dialer = openWsDialer({
		dialTimeoutMs: 5000,
		secretKeyHex: host.secretKeyHex,
		url: listener.url,
	});
	return {
		close: async () => {
			await dialer.close();
			await listener.close();
		},
		dial: () => dialer.dial(),
		gatewayId: gateway.publicKeyHex,
		hostId: host.publicKeyHex,
		listener,
	};
};

interface RawSocket {
	readonly send: (text: string) => void;
	readonly next: () => Promise<string>;
	readonly closed: Promise<boolean>;
}

/** A socket that speaks the handshake by hand, so a bad proof can be posted. */
const openRawSocket = async (url: string): Promise<RawSocket> => {
	const socket = new WebSocket(url);
	const queue: string[] = [];
	const readers: ((text: string) => void)[] = [];
	const closed = Promise.withResolvers<boolean>();
	const opened = Promise.withResolvers<boolean>();
	socket.addEventListener("message", (event) => {
		const text = String(event.data);
		const reader = readers.shift();
		if (reader === undefined) {
			queue.push(text);
		} else {
			reader(text);
		}
	});
	socket.addEventListener("close", () => closed.resolve(true));
	socket.addEventListener("error", () =>
		opened.reject(new Error("raw socket failed"))
	);
	socket.addEventListener("open", () => opened.resolve(true));
	await opened.promise;
	return {
		closed: closed.promise,
		next: () => {
			const queued = queue.shift();
			if (queued !== undefined) {
				return Promise.resolve(queued);
			}
			const pending = Promise.withResolvers<string>();
			readers.push(pending.resolve);
			return pending.promise;
		},
		send: (text) => socket.send(text),
	};
};

describe("WebSocket transport", () => {
	test("authenticates both peers and round-trips messages", async () => {
		const peers = await openPeers();
		try {
			const dialed = peers.dial();
			const accepted = await peers.listener.accept();
			const connection = await dialed;
			expect(connection.remoteId).toBe(peers.gatewayId);
			expect(accepted.remoteId).toBe(peers.hostId);
			expect(peers.listener.localId).toBe(peers.gatewayId);

			await connection.send(encoder.encode("hello gateway"));
			expect(decoder.decode(await accepted.receive())).toBe("hello gateway");
			await accepted.send(encoder.encode("hello host"));
			expect(decoder.decode(await connection.receive())).toBe("hello host");

			const binary = Uint8Array.from([0, 1, 2, 253, 254, 255]);
			await connection.send(binary);
			expect([...(await accepted.receive())]).toEqual([...binary]);
		} finally {
			await peers.close();
		}
	});

	test("carries several connections over one listener independently", async () => {
		const peers = await openPeers();
		try {
			const first = await peers.dial();
			const acceptedFirst = await peers.listener.accept();
			const second = await peers.dial();
			const acceptedSecond = await peers.listener.accept();

			await first.send(encoder.encode("one"));
			await second.send(encoder.encode("two"));
			expect(decoder.decode(await acceptedFirst.receive())).toBe("one");
			expect(decoder.decode(await acceptedSecond.receive())).toBe("two");

			await first.close();
			await expect(acceptedFirst.receive()).rejects.toThrow();
			await second.send(encoder.encode("still open"));
			expect(decoder.decode(await acceptedSecond.receive())).toBe("still open");
		} finally {
			await peers.close();
		}
	});

	test("rejects dialing the identity you already are", async () => {
		const identity = generateIdentity();
		const listener = await startWsListener({
			secretKeyHex: identity.secretKeyHex,
		});
		const dialer = openWsDialer({
			secretKeyHex: identity.secretKeyHex,
			url: listener.url,
		});
		try {
			await expect(dialer.dial()).rejects.toBeInstanceOf(SelfDialError);
		} finally {
			await dialer.close();
			await listener.close();
		}
	});

	test("refuses an address that is not a ws:// or wss:// URL", () => {
		const identity = generateIdentity();
		expect(() =>
			openWsDialer({ secretKeyHex: identity.secretKeyHex, url: "not-a-url" })
		).toThrow(InvalidTransportUrlError);
		expect(() =>
			openWsDialer({
				secretKeyHex: identity.secretKeyHex,
				url: "https://supervillain.test",
			})
		).toThrow(InvalidTransportUrlError);
	});

	test("times out a dial that never completes its upgrade", async () => {
		const stalled = new Set<Socket>();
		const silent = createServer((socket) => {
			stalled.add(socket);
			socket.on("close", () => stalled.delete(socket));
		});
		await new Promise<void>((resolve) => {
			silent.listen(0, "127.0.0.1", () => resolve());
		});
		const address = silent.address();
		if (address === null || typeof address === "string") {
			throw new Error("test server did not bind a port.");
		}
		const identity = generateIdentity();
		const dialer = openWsDialer({
			dialTimeoutMs: 150,
			secretKeyHex: identity.secretKeyHex,
			url: `ws://127.0.0.1:${address.port}`,
		});
		try {
			expect(await captureRejection(dialer.dial())).toBeInstanceOf(
				DialTimeoutError
			);
		} finally {
			await dialer.close();
			for (const socket of stalled) {
				socket.destroy();
			}
			await new Promise<void>((resolve) => {
				silent.close(() => resolve());
			});
		}
	});

	test("never hands up a peer whose signature does not verify", async () => {
		const gateway = generateIdentity();
		const impostor = generateIdentity();
		const listener = await startWsListener({
			secretKeyHex: gateway.secretKeyHex,
		});
		try {
			const raw = await openRawSocket(listener.url);
			raw.send(
				JSON.stringify({
					id: impostor.publicKeyHex,
					nonce: "a".repeat(64),
					v: 1,
				})
			);
			await raw.next();
			raw.send(JSON.stringify({ signature: "00".repeat(64), v: 1 }));
			await raw.closed;
		} finally {
			await listener.close();
		}
	});

	test("ends a pending accept once the listener closes", async () => {
		const identity = generateIdentity();
		const listener = await startWsListener({
			secretKeyHex: identity.secretKeyHex,
		});
		const pending = captureRejection(listener.accept());
		await listener.close();
		expect(await pending).toBeInstanceOf(TransportListenerClosedError);
		expect(await captureRejection(listener.accept())).toBeInstanceOf(
			TransportListenerClosedError
		);
	});

	test("fails a pending receive when the peer closes", async () => {
		const peers = await openPeers();
		try {
			const connection = await peers.dial();
			const accepted = await peers.listener.accept();
			const pending = captureRejection(accepted.receive());
			await connection.close();
			expect(await pending).toBeInstanceOf(Error);
			expect(await captureRejection(connection.receive())).toBeInstanceOf(
				Error
			);
		} finally {
			await peers.close();
		}
	});

	test("refuses to send a message past the size cap", async () => {
		const peers = await openPeers();
		try {
			const connection = await peers.dial();
			await peers.listener.accept();
			await expect(
				connection.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))
			).rejects.toBeInstanceOf(RangeError);
		} finally {
			await peers.close();
		}
	});

	test("closes every live connection when the listener shuts down", async () => {
		const peers = await openPeers();
		const connection = await peers.dial();
		const accepted = await peers.listener.accept();
		await peers.close();
		await expect(accepted.receive()).rejects.toThrow();
		await expect(connection.receive()).rejects.toThrow();
	});
});
