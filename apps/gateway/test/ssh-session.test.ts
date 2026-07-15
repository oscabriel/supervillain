/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { guestUpgradeBox, isGuestActor, mintGuestActor } from "../src/guest.js";
import { attachSshChannel } from "../src/ssh-session.js";
import type { SshChannelStream } from "../src/ssh-session.js";

const fakeChannel = (): SshChannelStream =>
	new PassThrough() as unknown as SshChannelStream;

describe("attachSshChannel", () => {
	test("exposes the channel as the session's streams and marks it a TTY", () => {
		const stream = fakeChannel();
		const session = attachSshChannel({
			actor: "abc",
			initialSize: { columns: 120, rows: 40 },
			stream,
		});
		expect(session.actor).toBe("abc");
		expect(session.input).toBe(stream as never);
		expect(session.output).toBe(stream as never);
		expect(stream.isTTY).toBe(true);
		expect(session.size()).toEqual({ columns: 120, rows: 40 });
	});

	test("falls back to 80x24 when the client reports a zero-size pty", () => {
		const session = attachSshChannel({
			actor: "abc",
			initialSize: { columns: 0, rows: 0 },
			stream: fakeChannel(),
		});
		expect(session.size()).toEqual({ columns: 80, rows: 24 });
	});

	test("routes resize() to listeners and updates size()", () => {
		const session = attachSshChannel({
			actor: "abc",
			initialSize: { columns: 80, rows: 24 },
			stream: fakeChannel(),
		});
		const seen: { columns: number; rows: number }[] = [];
		const unsubscribe = session.onResize((size) => seen.push(size));
		session.resize({ columns: 100, rows: 30 });
		expect(session.size()).toEqual({ columns: 100, rows: 30 });
		unsubscribe();
		session.resize({ columns: 90, rows: 25 });
		expect(seen).toEqual([{ columns: 100, rows: 30 }]);
	});

	test("notifies close once, on stream close or session close", () => {
		const stream = fakeChannel();
		const session = attachSshChannel({
			actor: "abc",
			initialSize: { columns: 80, rows: 24 },
			stream,
		});
		let closes = 0;
		session.onClose(() => {
			closes += 1;
		});
		session.close();
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
