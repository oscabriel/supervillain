import { describe, expect, test } from "bun:test";
/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/class-methods-use-this, promise/avoid-new -- Bun-only suite: the gateway store is Bun-bound by bun:sqlite, and the fake store is interface-shaped. */
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
import {
	openGatewayLink,
	openHostPipe,
	serveHostPipes,
} from "@supervillain/room-wire";
import { openWsDialer } from "@supervillain/transport-ws";
import { startWsListener } from "@supervillain/transport-ws/server";

import { guestUpgradeBox } from "../src/guest.js";
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
				next: (): Promise<IteratorResult<Envelope>> =>
					// oxlint-disable-next-line promise/avoid-new -- a stream that never yields is the fixture.
					new Promise<IteratorResult<Envelope>>(() => {
						/* a stream that never ends */
					}),
			}),
		};
	}
}

interface Machine {
	readonly key: string;
	readonly secret: string;
}

const machineIn = async (folder: string): Promise<Machine> => {
	const identity = await loadOrCreateIdentity(path.join(folder, randomUUID()));
	return { key: identity.publicKeyHex, secret: identity.secretKeyHex };
};

const until = async (present: () => boolean, what: string): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (present()) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point of the wait.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
	throw new Error(`${what} never happened.`);
};

describe("key linking over the gateway pipe", () => {
	test("links a second machine, then tells an offline room what it missed", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-link-"));
		const registry = openRoomRegistry({ path: ":memory:" });
		const gatewayMachine = await machineIn(folder);
		const listener = await startWsListener({
			secretKeyHex: gatewayMachine.secret,
		});
		const pipes = serveHostPipes({
			door: DOOR,
			keys: registry,
			listener,
			ownership: registry,
		});
		const desktop = await machineIn(folder);
		const laptop = await machineIn(folder);

		// The desktop already holds a name.
		const first = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: desktop.secret, url: listener.url }),
			rooms: [
				{
					actors: () => [desktop.key],
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store: new FakeRoomStore(),
				},
			],
		});
		await first.attached;
		await until(
			() => pipes.live("iron-keep") !== undefined,
			"the room attaching"
		);
		await first.close();
		await until(
			() => pipes.live("iron-keep") === undefined,
			"the room going offline"
		);

		// While the room is down, the GM links the laptop from the desktop.
		const established = await openGatewayLink({
			dialer: openWsDialer({ secretKeyHex: desktop.secret, url: listener.url }),
		});
		const minted = await established.mintDeviceCode();
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		await established.close();

		const fresh = await openGatewayLink({
			dialer: openWsDialer({ secretKeyHex: laptop.secret, url: listener.url }),
		});
		expect(await fresh.redeem(minted.code)).toMatchObject({
			accepted: true,
			linked: desktop.key,
		});
		await fresh.close();
		expect(registry.identityOf(laptop.key)).toBe(
			registry.identityOf(desktop.key)
		);

		// The room comes back up on the *laptop*. It keeps the name, and it is
		// told about the linking it slept through — with no queue anywhere.
		const store = new FakeRoomStore();
		const second = openHostPipe({
			dialer: openWsDialer({ secretKeyHex: laptop.secret, url: listener.url }),
			rooms: [
				{
					actors: () => [desktop.key],
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		await expect(second.attached).resolves.toMatchObject({
			sshHost: "supervillain.test",
		});
		await until(() => store.submissions.length > 0, "the linking submission");
		expect(store.submissions).toEqual([
			{
				actor: laptop.key,
				command: { linked: desktop.key, type: "core.link-actor" },
			},
		]);

		await second.close();
		await pipes.close();
		await listener.close();
		registry.close();
		await rm(folder, { force: true, recursive: true });
	});
});

describe("the guest upgrade box", () => {
	test("carries an adoption code when the gateway minted one", () => {
		const registry = openRoomRegistry({ path: ":memory:" });
		const minted = registry.mintAdoptionCode("guest:abc123def456");
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		const box = guestUpgradeBox(minted.code);
		expect(box).toContain(`supervillain key link ${minted.code}`);
		expect(box).toContain("within 7 days");
		// Every line of the box is the same width, code or no code.
		const widths = new Set(
			box
				.split("\r\n")
				.filter((line) => line.startsWith("  "))
				.map((line) => [...line].length)
		);
		expect(widths.size).toBe(1);
		registry.close();
	});

	test("falls back to the bring-a-key line with no code", () => {
		const box = guestUpgradeBox();
		expect(box).toContain("ssh-keygen -t ed25519");
		expect(box).not.toContain("key link");
	});
});
