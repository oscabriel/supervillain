/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, promise/avoid-new -- dual-lane suite: interface-shaped async fakes with a deliberately pending stream. */
import type {
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import { openHostPipe, TransportTrustError } from "../src/index.js";
import type {
	HostPipeEvent,
	TransportConnection,
	TransportDialer,
} from "../src/index.js";
import { describe, expect, test } from "./harness.js";

class SilentRoomStore implements RoomStore {
	async submit(_command: RoomCommand): Promise<RoomSubmission> {
		return { accepted: true, envelopes: [] };
	}

	stream(): AsyncIterable<never> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<never>>(() => {}),
			}),
		};
	}
}

const dialerThatThrows = (message: string): TransportDialer => ({
	dial: (): Promise<TransportConnection> => Promise.reject(new Error(message)),
});

const room = {
	info: { gameId: "fake", label: "the table" },
	name: "iron-keep",
	store: new SilentRoomStore(),
};

describe("the Host pipe's redial loop", () => {
	test("stops on a trust failure instead of dialing the wrong gateway forever", async () => {
		let dials = 0;
		const pipe = openHostPipe({
			dialer: {
				dial: (): Promise<TransportConnection> => {
					dials += 1;
					return Promise.reject(
						new TransportTrustError("the certificate is not the pinned one")
					);
				},
			},
			reconnectDelayMs: () => 1,
			rooms: [room],
		});
		await expect(pipe.attached).rejects.toBeInstanceOf(TransportTrustError);
		expect(dials).toBe(1);
		await pipe.close();
	});

	test("keeps redialing an unreachable gateway and reports the last failure", async () => {
		const dials = { count: 0 };
		const events: HostPipeEvent[] = [];
		const pipe = openHostPipe({
			dialer: {
				dial: (): Promise<TransportConnection> => {
					dials.count += 1;
					return Promise.reject(new Error("connection refused"));
				},
			},
			onEvent: (event) => events.push(event),
			reconnectDelayMs: () => 1,
			rooms: [room],
		});
		for (let attempt = 0; attempt < 50 && dials.count < 3; attempt += 1) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- polling the redial loop is the point of the wait.
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5);
			});
		}
		expect(dials.count).toBeGreaterThan(1);
		expect(events.slice(0, 2)).toEqual([
			{ attempt: 1, kind: "dialing" },
			{ attempt: 2, kind: "dialing", lastError: "connection refused" },
		]);
		await pipe.close();
		await expect(pipe.attached).rejects.toThrow();
	});

	test("a dialer that never dials is still refused when the pipe closes", async () => {
		const pipe = openHostPipe({
			dialer: dialerThatThrows("nope"),
			reconnectDelayMs: () => 10_000,
			rooms: [room],
		});
		await pipe.close();
		await expect(pipe.attached).rejects.toThrow();
	});
});
