/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/max-classes-per-file, eslint/class-methods-use-this, promise/avoid-new -- dual-lane registration suite uses interface-shaped async fakes with a deliberately pending stream. */
import type {
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import {
	connectRoomStore,
	isValidRoomName,
	registerRoom,
	serveRoomRegistry,
	serveRoomStore,
} from "../src/index.js";
import type {
	RegistrationOutcome,
	RoomRegistration,
	RoomRegistry,
} from "../src/index.js";
import { createMemoryEndpointPair, describe, expect, test } from "./harness.js";

class TestRegistry implements RoomRegistry {
	readonly registrations: { owner: string; registration: RoomRegistration }[] =
		[];
	outcome: RegistrationOutcome = {
		accepted: true,
		sshHost: "supervillain.test",
		sshPort: 22,
	};

	async register(
		owner: string,
		registration: RoomRegistration
	): Promise<RegistrationOutcome> {
		this.registrations.push({ owner, registration });
		return this.outcome;
	}
}

class RecordingRoomStore implements RoomStore {
	readonly submissions: RoomCommand[] = [];

	async submit(command: RoomCommand): Promise<RoomSubmission> {
		this.submissions.push(command);
		return { accepted: true, envelopes: [] };
	}

	stream(): AsyncIterable<never> {
		return {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<never>>(() => {}),
				};
			},
		};
	}
}

describe("room registration protocol", () => {
	test("validates room names", () => {
		expect(isValidRoomName("iron-keep")).toBe(true);
		expect(isValidRoomName("a")).toBe(true);
		expect(isValidRoomName("-lead")).toBe(false);
		expect(isValidRoomName("trail-")).toBe(false);
		expect(isValidRoomName("Upper")).toBe(false);
		expect(isValidRoomName("")).toBe(false);
		expect(isValidRoomName("x".repeat(33))).toBe(false);
	});

	test("registers a room and returns the gateway's identity in the receipt", async () => {
		const { client, server } = createMemoryEndpointPair(
			"gm-key",
			"gateway-key"
		);
		const registry = new TestRegistry();
		const registryServer = serveRoomRegistry(server, registry);
		const receipt = await registerRoom(client, server.address, {
			address: "memory:gm-host",
			name: "iron-keep",
		});
		expect(receipt).toEqual({
			gatewayId: "gateway-key",
			sshHost: "supervillain.test",
			sshPort: 22,
		});
		expect(registry.registrations).toEqual([
			{
				owner: "gm-key",
				registration: { address: "memory:gm-host", name: "iron-keep" },
			},
		]);
		await registryServer.close();
	});

	test("rejects an invalid name at the wire without consulting the registry", async () => {
		const { client, server } = createMemoryEndpointPair(
			"gm-key",
			"gateway-key"
		);
		const registry = new TestRegistry();
		const registryServer = serveRoomRegistry(server, registry);
		await expect(
			registerRoom(client, server.address, {
				address: "memory:gm-host",
				name: "Iron Keep",
			})
		).rejects.toThrow("Room names are 1-32 lowercase letters");
		expect(registry.registrations).toEqual([]);
		await registryServer.close();
	});

	test("surfaces a registry rejection as a thrown error", async () => {
		const { client, server } = createMemoryEndpointPair(
			"gm-key",
			"gateway-key"
		);
		const registry = new TestRegistry();
		registry.outcome = {
			message: "The name 'iron-keep' is already claimed by another key.",
			rejected: true,
		};
		const registryServer = serveRoomRegistry(server, registry);
		await expect(
			registerRoom(client, server.address, {
				address: "memory:gm-host",
				name: "iron-keep",
			})
		).rejects.toThrow("already claimed by another key");
		await registryServer.close();
	});
});

describe("trusted stampers", () => {
	test("lets a trusted connection submit on behalf of other actors", async () => {
		const { client, server } = createMemoryEndpointPair(
			"gateway-key",
			"host-key"
		);
		const store = new RecordingRoomStore();
		const roomServer = serveRoomStore(server, store, {
			info: { gameId: "fake", label: "table" },
			trustedStampers: ["gateway-key"],
		});
		const remote = await connectRoomStore(client, server.address);
		const stamped = await remote.submit({
			actor: "guest:abc123def456",
			command: { type: "core.claim-seat" },
		});
		expect(stamped).toEqual({ accepted: true, envelopes: [] });
		expect(store.submissions).toEqual([
			{ actor: "guest:abc123def456", command: { type: "core.claim-seat" } },
		]);
		await remote.close();
		await roomServer.close();
	});

	test("still rejects mismatched actors from untrusted connections", async () => {
		const { client, server } = createMemoryEndpointPair(
			"player-key",
			"host-key"
		);
		const store = new RecordingRoomStore();
		const roomServer = serveRoomStore(server, store, {
			info: { gameId: "fake", label: "table" },
			trustedStampers: ["gateway-key"],
		});
		const remote = await connectRoomStore(client, server.address);
		const rejected = await remote.submit({
			actor: "someone-else",
			command: { type: "core.claim-seat" },
		});
		expect(rejected).toEqual({
			message: "Actor does not match the connection identity.",
			rejected: true,
		});
		expect(store.submissions).toEqual([]);
		await remote.close();
		await roomServer.close();
	});
});
