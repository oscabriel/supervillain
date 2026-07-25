/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
	guestIdentity,
	guestUpgradeBox,
	isGuestActor,
	keyedIdentity,
	mintGuestActor,
} from "../src/guest.js";
import { attachSshChannel, sessionForActor } from "../src/ssh-session.js";
import type { SshChannelStream } from "../src/ssh-session.js";

const fakeChannel = (): SshChannelStream =>
	new PassThrough() as unknown as SshChannelStream;

describe("attachSshChannel", () => {
	test("exposes the channel as the connection's streams and marks it a TTY", () => {
		const stream = fakeChannel();
		const connection = attachSshChannel({
			initialSize: { columns: 120, rows: 40 },
			stream,
		});
		expect(connection.input).toBe(stream as never);
		expect(connection.output).toBe(stream as never);
		expect(stream.isTTY).toBe(true);
		expect(connection.size()).toEqual({ columns: 120, rows: 40 });
	});

	test("carries no actor until one is bound to it", () => {
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			stream: fakeChannel(),
		});
		expect("actor" in connection).toBe(false);
		expect(sessionForActor(connection, "abc").actor).toBe("abc");
	});

	test("falls back to 80x24 when the client reports a zero-size pty", () => {
		const connection = attachSshChannel({
			initialSize: { columns: 0, rows: 0 },
			stream: fakeChannel(),
		});
		expect(connection.size()).toEqual({ columns: 80, rows: 24 });
	});

	test("routes resize() to listeners and updates size()", () => {
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			stream: fakeChannel(),
		});
		const seen: { columns: number; rows: number }[] = [];
		const unsubscribe = connection.onResize((size) => seen.push(size));
		connection.resize({ columns: 100, rows: 30 });
		expect(connection.size()).toEqual({ columns: 100, rows: 30 });
		unsubscribe();
		connection.resize({ columns: 90, rows: 25 });
		expect(seen).toEqual([{ columns: 100, rows: 30 }]);
	});

	test("a bound session shares the connection's resize and size", () => {
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			stream: fakeChannel(),
		});
		const session = sessionForActor(connection, "abc");
		connection.resize({ columns: 100, rows: 30 });
		expect(session.size()).toEqual({ columns: 100, rows: 30 });
	});

	test("notifies close once, on stream close or connection close", () => {
		const stream = fakeChannel();
		const connection = attachSshChannel({
			initialSize: { columns: 80, rows: 24 },
			stream,
		});
		let closes = 0;
		connection.onClose(() => {
			closes += 1;
		});
		connection.close();
		stream.emit("close");
		expect(closes).toBe(1);
	});
});

describe("guest identity", () => {
	test("mints disjoint guest actors and recognizes them", () => {
		const guest = mintGuestActor();
		expect(guest).toMatch(/^guest:[0-9a-f]{12}$/u);
		expect(isGuestActor(guest)).toBe(true);
		expect(isGuestActor("a".repeat(64))).toBe(false);
		expect(mintGuestActor()).not.toBe(guest);
	});

	test("the upgrade box tells guests how to bring a key", () => {
		expect(guestUpgradeBox()).toContain("ssh-keygen -t ed25519");
	});
});

describe("lazy guest minting", () => {
	test("a guest that never enters a room never gets an actor", () => {
		let mints = 0;
		const identity = guestIdentity(() => {
			mints += 1;
			return mintGuestActor();
		});
		expect(identity.keyed).toBe(false);
		expect(identity.actor()).toBeUndefined();
		expect(mints).toBe(0);
	});

	test("mints exactly one actor at first room entry and reuses it across hops", () => {
		let mints = 0;
		const identity = guestIdentity(() => {
			mints += 1;
			return `guest:${"a".repeat(11)}${mints}`;
		});
		const first = identity.assume();
		expect(first.minted).toBe(true);
		expect(isGuestActor(first.actor)).toBe(true);
		const second = identity.assume();
		expect(second.minted).toBe(false);
		expect(second.actor).toBe(first.actor);
		expect(identity.actor()).toBe(first.actor);
		expect(mints).toBe(1);
	});

	test("a keyed connection resolves at connect and mints nothing", () => {
		const identity = keyedIdentity("a".repeat(64));
		expect(identity.keyed).toBe(true);
		expect(identity.actor()).toBe("a".repeat(64));
		expect(identity.assume()).toEqual({
			actor: "a".repeat(64),
			minted: false,
		});
	});
});
