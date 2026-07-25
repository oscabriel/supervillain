/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, eslint/max-classes-per-file, promise/avoid-new -- dual-lane suite: interface-shaped async fakes (one per role) and timer-based settles. */
/**
 * The concurrency cap on rooms per identity (ADR-0012, NQ-10). It is a cost
 * ceiling on what the box carries right now, never a claim on a name: a
 * refused room is still owned, and it attaches the moment one of that
 * identity's others lets go.
 */
import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import { openHostPipe, serveHostPipes } from "../src/index.js";
import type {
	ClaimOutcome,
	HostPipeServer,
	RoomOwnership,
} from "../src/index.js";
import { createMemoryTransportHub, describe, expect, test } from "./harness.js";

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;

class QuietRoom implements RoomStore {
	async submit(): Promise<RoomSubmission> {
		return { accepted: true, envelopes: [] };
	}

	stream(): AsyncIterable<Envelope> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () =>
					new Promise<IteratorResult<Envelope>>(() => {
						// A quiet room's feed simply never yields.
					}),
			}),
		};
	}
}

/** Ownership keyed on the host key, exactly as the gateway's store resolves it
 * today: one identity per key. */
class MemoryOwnership implements RoomOwnership {
	readonly claims: RoomCommand[] = [];

	async claim(hostKey: string, _name: string): Promise<ClaimOutcome> {
		return { accepted: true, ownerId: `identity:${hostKey}` };
	}
}

const untilLive = async (
	server: HostPipeServer,
	name: string
): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (server.live(name) !== undefined) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- polling a live registration is the wait.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	throw new Error(`Room '${name}' never attached.`);
};

const hostFor = (
	hub: ReturnType<typeof createMemoryTransportHub>,
	key: string,
	name: string
): ReturnType<typeof openHostPipe> =>
	openHostPipe({
		dialer: hub.dialer(key),
		rooms: [
			{ info: { gameId: "fake", label: name }, name, store: new QuietRoom() },
		],
	});

describe("rooms per identity", () => {
	test("refuses the room past the cap, keeps the ones already carried, and says why", async () => {
		const hub = createMemoryTransportHub();
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
			roomsPerIdentity: 1,
		});
		const first = hostFor(hub, "gm-key", "iron-keep");
		await first.attached;
		await untilLive(pipes, "iron-keep");

		const second = hostFor(hub, "gm-key", "salt-marsh");
		let refusal: Error | undefined;
		try {
			await second.attached;
		} catch (error) {
			refusal = error as Error;
		}
		expect(refusal).toBeInstanceOf(Error);
		expect(refusal?.message).toContain("salt-marsh");
		expect(refusal?.message).toContain("still yours");
		expect(pipes.liveNames()).toEqual(["iron-keep"]);

		// Another identity is not affected by this one's ceiling.
		const other = hostFor(hub, "other-key", "black-fen");
		await other.attached;
		await untilLive(pipes, "black-fen");
		expect(pipes.liveNames().toSorted()).toEqual(["black-fen", "iron-keep"]);

		await first.close();
		await second.close();
		await other.close();
		await pipes.close();
	});

	test("re-registering a name the identity already carries is never refused", async () => {
		const hub = createMemoryTransportHub();
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
			roomsPerIdentity: 1,
		});
		const first = hostFor(hub, "gm-key", "iron-keep");
		await first.attached;
		await untilLive(pipes, "iron-keep");

		// A crash-restart or a machine move: the same identity supersedes its own
		// live registration, and that costs it nothing against the cap.
		const restarted = hostFor(hub, "gm-key", "iron-keep");
		await restarted.attached;
		await untilLive(pipes, "iron-keep");
		expect(pipes.liveNames()).toEqual(["iron-keep"]);

		await first.close();
		await restarted.close();
		await pipes.close();
	});

	test("no cap means no refusal", async () => {
		const hub = createMemoryTransportHub();
		const pipes = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const first = hostFor(hub, "gm-key", "iron-keep");
		const second = hostFor(hub, "gm-key", "salt-marsh");
		await first.attached;
		await second.attached;
		await untilLive(pipes, "iron-keep");
		await untilLive(pipes, "salt-marsh");
		expect(pipes.liveNames()).toHaveLength(2);

		await first.close();
		await second.close();
		await pipes.close();
	});
});
