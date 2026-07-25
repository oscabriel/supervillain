/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/max-classes-per-file, eslint/class-methods-use-this, promise/avoid-new -- dual-lane broker suite: interface-shaped async fakes over the memory transport. */
import type {
	Envelope,
	RoomCommand,
	RoomStore,
	RoomSubmission,
} from "@supervillain/core";

import { openGatewayLink, openHostPipe, serveHostPipes } from "../src/index.js";
import type {
	ActorLink,
	ClaimOutcome,
	GatewayPipeEvent,
	KeyGraph,
	LinkCodeOutcome,
	LinkRedemptionOutcome,
	RoomOwnership,
} from "../src/index.js";
import { createMemoryTransportHub, describe, expect, test } from "./harness.js";

const DOOR = { sshHost: "supervillain.test", sshPort: 2222 } as const;
const DESKTOP = "gm-key";
const LAPTOP = "laptop-key";
const GUEST = "guest:abc123def456";

class MemoryOwnership implements RoomOwnership {
	readonly names = new Map<string, string>();

	async claim(hostKey: string, name: string): Promise<ClaimOutcome> {
		const ownerId = `identity:${hostKey}`;
		this.names.set(name, ownerId);
		return { accepted: true, ownerId };
	}
}

class RecordingRoomStore implements RoomStore {
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

/**
 * The graph as the broker sees it — an object, not a driver. This suite runs
 * under Node as well as Bun precisely because nothing here can reach a database
 * (NQ-12): the gateway's `bun:sqlite` store satisfies this same interface.
 */
class MemoryKeyGraph implements KeyGraph {
	readonly identities = new Map<string, string>();
	readonly codes = new Map<string, string>();
	readonly rosters: (readonly string[])[] = [];
	minted = 0;

	async resolveActorLinks(
		actors: readonly string[]
	): Promise<readonly ActorLink[]> {
		this.rosters.push(actors);
		const known = new Set(actors);
		const anchors = new Map<string, string>();
		for (const actor of [...known].toSorted()) {
			const identity = this.identities.get(actor);
			if (identity !== undefined && !anchors.has(identity)) {
				anchors.set(identity, actor);
			}
		}
		const links: ActorLink[] = [];
		for (const [identity, anchor] of anchors) {
			for (const [actor, holder] of this.identities) {
				if (holder === identity && !known.has(actor)) {
					links.push({ actor, linked: anchor });
				}
			}
		}
		return links;
	}

	async mintDeviceCode(key: string): Promise<LinkCodeOutcome> {
		this.minted += 1;
		const code = `CODE${this.minted}`;
		this.codes.set(code, this.identities.get(key) ?? key);
		return { accepted: true, code, expiresAt: "2026-07-25T00:15:00.000Z" };
	}

	async redeemLinkCode(
		code: string,
		key: string
	): Promise<LinkRedemptionOutcome> {
		const identity = this.codes.get(code);
		if (identity === undefined) {
			return { message: "That link code is not valid.", rejected: true };
		}
		this.codes.delete(code);
		this.identities.set(key, identity);
		return { accepted: true, identityId: identity, linked: identity };
	}
}

const settle = async (turns = 12): Promise<void> => {
	for (let turn = 0; turn < turns; turn += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- draining the event loop is the point.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 1);
		});
	}
};

describe("derived linking at registration", () => {
	test("tells an offline room what it missed, as a gateway-stamped submission", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const keys = new MemoryKeyGraph();
		// The linking happened while this room's Host was down: the laptop key
		// and the desktop key are one identity at the gateway, and the log has
		// never heard of the laptop.
		keys.identities.set(DESKTOP, "identity:one");
		keys.identities.set(LAPTOP, "identity:one");
		const events: GatewayPipeEvent[] = [];
		const server = serveHostPipes({
			door: DOOR,
			keys,
			listener: hub.listener,
			onEvent: (event) => events.push(event),
			ownership: new MemoryOwnership(),
		});
		const store = new RecordingRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer(DESKTOP),
			rooms: [
				{
					actors: () => [DESKTOP],
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		await host.attached;
		await settle();
		expect(keys.rosters).toEqual([[DESKTOP]]);
		expect(store.submissions).toEqual([
			{ actor: LAPTOP, command: { linked: DESKTOP, type: "core.link-actor" } },
		]);
		expect(events).toContainEqual({
			kind: "room-linked",
			links: 1,
			room: "iron-keep",
		});
		await host.close();
		await server.close();
	});

	test("answers the unknown-key-joins question with the same query", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const keys = new MemoryKeyGraph();
		// The guest played last week; this week they installed the CLI and
		// redeemed their adoption code, so the graph knows the pair.
		keys.identities.set(GUEST, "identity:two");
		keys.identities.set(LAPTOP, "identity:two");
		const server = serveHostPipes({
			door: DOOR,
			keys,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const store = new RecordingRoomStore();
		let roster: readonly string[] = [DESKTOP];
		const host = openHostPipe({
			dialer: hub.dialer(DESKTOP),
			rooms: [
				{
					actors: () => roster,
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		await host.attached;
		await settle();
		// Nothing to tell yet: the room's log has never met either actor.
		expect(store.submissions).toEqual([]);

		// The guest's old line is in this room after all.
		roster = [DESKTOP, GUEST];
		const live = server.live("iron-keep");
		if (live === undefined) {
			throw new Error("no live room");
		}
		await live.deliverLinks();
		expect(store.submissions).toEqual([
			{ actor: LAPTOP, command: { linked: GUEST, type: "core.link-actor" } },
		]);
		await host.close();
		await server.close();
	});

	test("a room that already carries the link is told nothing", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const keys = new MemoryKeyGraph();
		keys.identities.set(DESKTOP, "identity:one");
		keys.identities.set(LAPTOP, "identity:one");
		const server = serveHostPipes({
			door: DOOR,
			keys,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const store = new RecordingRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer(DESKTOP),
			rooms: [
				{
					// Both actors are in the roster, so nothing is missing.
					actors: () => [DESKTOP, LAPTOP],
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		await host.attached;
		await settle();
		expect(store.submissions).toEqual([]);
		await host.close();
		await server.close();
	});

	test("a room that offers no roster still attaches", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const keys = new MemoryKeyGraph();
		const server = serveHostPipes({
			door: DOOR,
			keys,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const host = openHostPipe({
			dialer: hub.dialer(DESKTOP),
			rooms: [
				{
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store: new RecordingRoomStore(),
				},
			],
		});
		await expect(host.attached).resolves.toMatchObject({
			sshHost: "supervillain.test",
		});
		await settle();
		// An empty roster never reaches the graph: there is nothing to resolve.
		expect(keys.rosters).toEqual([]);
		await host.close();
		await server.close();
	});

	test("a gateway with no graph tells nobody anything", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const store = new RecordingRoomStore();
		const host = openHostPipe({
			dialer: hub.dialer(DESKTOP),
			rooms: [
				{
					actors: () => [DESKTOP, GUEST],
					info: { gameId: "fake", label: "the table" },
					name: "iron-keep",
					store,
				},
			],
		});
		await host.attached;
		await settle();
		expect(store.submissions).toEqual([]);
		await host.close();
		await server.close();
	});
});

describe("the key link conduit", () => {
	test("mints on one machine and redeems on another, over a room-less pipe", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const keys = new MemoryKeyGraph();
		keys.identities.set(DESKTOP, "identity:one");
		const server = serveHostPipes({
			door: DOOR,
			keys,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const established = await openGatewayLink({ dialer: hub.dialer(DESKTOP) });
		const minted = await established.mintDeviceCode();
		if ("rejected" in minted) {
			throw new Error(minted.message);
		}
		await established.close();

		const fresh = await openGatewayLink({ dialer: hub.dialer(LAPTOP) });
		const redeemed = await fresh.redeem(minted.code);
		expect(redeemed).toEqual({
			accepted: true,
			identityId: "identity:one",
			linked: "identity:one",
		});
		// Both keys now resolve to one identity.
		expect(keys.identities.get(LAPTOP)).toBe("identity:one");
		await fresh.close();
		await server.close();
	});

	test("surfaces a refusal instead of throwing", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			keys: new MemoryKeyGraph(),
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const link = await openGatewayLink({ dialer: hub.dialer(LAPTOP) });
		expect(await link.redeem("NOPE")).toEqual({
			message: "That link code is not valid.",
			rejected: true,
		});
		await link.close();
		await server.close();
	});

	test("a gateway with no graph refuses the whole conduit honestly", async () => {
		const hub = createMemoryTransportHub("gateway-key");
		const server = serveHostPipes({
			door: DOOR,
			listener: hub.listener,
			ownership: new MemoryOwnership(),
		});
		const link = await openGatewayLink({ dialer: hub.dialer(DESKTOP) });
		expect(await link.mintDeviceCode()).toEqual({
			message: "This gateway does not serve key linking.",
			rejected: true,
		});
		await link.close();
		await server.close();
	});
});
