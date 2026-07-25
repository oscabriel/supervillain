import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, promise/avoid-new -- Bun-only suite: the gateway is Bun-bound by bun:sqlite, and the fake store is interface-shaped. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";
import { loadOrCreateIdentity } from "@supervillain/identity";
import { openHostPipe, serveHostPipes } from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";

import { openRoomRegistry } from "../src/registry.js";

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;

class FakeRoomStore implements RoomStore {
	readonly submissions: RoomCommand[] = [];

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		return { accepted: true, envelopes: [] };
	}

	stream(): AsyncIterable<Envelope> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<Envelope>>(() => {}),
			}),
		};
	}
}

const identityIn = async (folder: string): Promise<string> => {
	const directory = path.join(folder, randomUUID());
	const identity = await loadOrCreateIdentity(directory);
	return identity.secretKeyHex;
};

const untilLive = async (
	present: () => boolean,
	what: string
): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (present()) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- polling a live registration is the point of the wait.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	throw new Error(`${what} never happened.`);
};

describe("the gateway's Host pipe", () => {
	test("accepts a challenge-signed Host, routes its Room, and refuses another key's claim", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-pipe-"));
		const registry = openRoomRegistry({ path: ":memory:" });
		const listener = await startWsListener({
			secretKeyHex: await identityIn(folder),
		});
		const pipes = serveHostPipes({
			door: DOOR,
			listener,
			ownership: registry,
		});
		const store = new FakeRoomStore();
		const host = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: await identityIn(folder),
				url: listener.url,
			}),
			rooms: [
				{
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		const attachment = await host.attached;
		expect(attachment.sshHost).toBe("supervillain.test");
		await untilLive(
			() => pipes.live("iron-keep") !== undefined,
			"the room attaching"
		);

		const view = pipes.live("iron-keep")?.openStore();
		if (view === undefined) {
			throw new Error("no live room");
		}
		expect(await view.info()).toEqual({ gameId: "fake", label: "the table" });
		expect(
			await view.submit({
				actor: "guest:abcdef123456",
				command: { type: "core.claim-seat" },
			})
		).toMatchObject({ accepted: true });
		expect(store.submissions).toHaveLength(1);
		await view.close();

		const thief = openHostPipe({
			dialer: openWsDialer({
				secretKeyHex: await identityIn(folder),
				url: listener.url,
			}),
			reconnectDelayMs: () => 1,
			rooms: [
				{
					info: { gameId: "fake", label: "not yours" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await expect(thief.attached).rejects.toThrow(
			"already claimed by another key"
		);
		await thief.close();

		await host.close();
		await untilLive(
			() => pipes.live("iron-keep") === undefined,
			"the room going offline"
		);
		await pipes.close();
		await listener.close();
		registry.close();
		await rm(folder, { force: true, recursive: true });
	});
});
