/* oxlint-disable vitest/prefer-importing-vitest-globals -- the gateway store and local conduit are Bun-bound. */
import { afterEach, describe, expect, test } from "bun:test";

import { startIdentityConduit } from "../src/identity-conduit.js";
import { openRoomRegistry } from "../src/registry.js";
import type { GatewayRoomRegistry } from "../src/registry.js";

const firstKey = "11".repeat(32);
const secondKey = "22".repeat(32);

const registries: GatewayRoomRegistry[] = [];
const conduits: { readonly close: () => Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(conduits.splice(0).map((conduit) => conduit.close()));
	for (const registry of registries.splice(0)) {
		registry.close();
	}
});

describe("the loopback-only identity conduit", () => {
	test("answers the web cold path with current and formerly linked owner identities", async () => {
		let identitySequence = 0;
		const registry = openRoomRegistry({
			newIdentityId: () => {
				identitySequence += 1;
				return `identity-${identitySequence}`;
			},
			newLinkCode: () => "01234567",
			path: ":memory:",
		});
		registries.push(registry);
		const formerIdentity = registry.resolveIdentity(firstKey);
		const currentIdentity = registry.resolveIdentity(secondKey);
		const code = await registry.mintDeviceCode(secondKey);
		if (!("accepted" in code)) {
			throw new Error(code.message);
		}
		const linked = await registry.redeemLinkCode(code.code, firstKey);
		expect(linked).toMatchObject({
			accepted: true,
			identityId: currentIdentity,
		});

		const conduit = await startIdentityConduit({
			directory: registry,
			port: 0,
		});
		conduits.push(conduit);
		const response = await fetch(`${conduit.url}/identity/resolve`, {
			body: JSON.stringify({ key: firstKey }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			identityId: currentIdentity,
			ownerIdentityIds: [currentIdentity, formerIdentity],
			revoked: false,
		});
	});

	test("reports retired keys without exposing a public bind option", async () => {
		const registry = openRoomRegistry({ path: ":memory:" });
		registries.push(registry);
		registry.resolveIdentity(firstKey);
		registry.resolveIdentity(secondKey);
		const code = await registry.mintDeviceCode(firstKey);
		if (!("accepted" in code)) {
			throw new Error(code.message);
		}
		const linked = await registry.redeemLinkCode(code.code, secondKey);
		if (!("accepted" in linked)) {
			throw new Error(linked.message);
		}
		const revoked = await registry.revokeKey(secondKey, firstKey);
		expect(revoked).toMatchObject({ accepted: true });

		const conduit = await startIdentityConduit({
			directory: registry,
			port: 0,
		});
		conduits.push(conduit);
		const response = await fetch(`${conduit.url}/identity/resolve`, {
			body: JSON.stringify({ key: secondKey }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(await response.json()).toMatchObject({ revoked: true });
		expect(new URL(conduit.url).hostname).toBe("127.0.0.1");
	});
});
