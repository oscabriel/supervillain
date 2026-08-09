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
import {
	attachDoorConnection,
	holdDoorInput,
	sessionForActor,
} from "../src/ssh-session.js";
import type { DoorChannel } from "../src/ssh-session.js";

const CAP = { columns: 300, rows: 100 };

interface ChannelProbe {
	readonly channel: DoorChannel;
	readonly written: () => string;
	readonly resize: (cols: number, rows: number) => void;
	readonly close: () => void;
	readonly resizeListeners: () => number;
	readonly closeListeners: () => number;
}

/** A plain fake of the slice of `@opentui/ssh`'s session the Door adapts. */
const fakeChannel = (cols = 120, rows = 40): ChannelProbe => {
	const resizeListeners = new Set<(cols: number, rows: number) => void>();
	const closeListeners = new Set<() => void>();
	let written = "";
	let closed = false;
	return {
		channel: {
			cols,
			onClose(listener) {
				// Pinned `@opentui/ssh` bridge.ts:196-203: close is level-triggered
				// and a subscriber arriving after transport close fires immediately.
				if (closed) {
					listener();
					return () => {};
				}
				closeListeners.add(listener);
				return () => closeListeners.delete(listener);
			},
			onResize(listener) {
				resizeListeners.add(listener);
				return () => resizeListeners.delete(listener);
			},
			rows,
			write(data) {
				written += data.toString();
			},
		},
		close() {
			if (closed) {
				return;
			}
			closed = true;
			for (const listener of closeListeners) {
				listener();
			}
			closeListeners.clear();
		},
		closeListeners: () => closeListeners.size,
		resize(nextCols, nextRows) {
			for (const listener of resizeListeners) {
				listener(nextCols, nextRows);
			}
		},
		resizeListeners: () => resizeListeners.size,
		written: () => written,
	};
};

const input = (): NodeJS.ReadStream =>
	new PassThrough() as unknown as NodeJS.ReadStream;

interface HoldProbe {
	readonly held: ReturnType<typeof holdDoorInput>;
	readonly seen: string[];
	readonly stream: PassThrough;
}

/** A stream with the renderer's posture: one 'data' consumer attached before
 * any hold exists, exactly like setupTerminal's stdinListener. */
const holdProbe = (): HoldProbe => {
	const stream = new PassThrough();
	const seen: string[] = [];
	stream.on("data", (chunk: Buffer) => {
		seen.push(chunk.toString());
	});
	return {
		held: holdDoorInput(stream as unknown as NodeJS.ReadStream),
		seen,
		stream,
	};
};

describe("attachDoorConnection", () => {
	test("borrows the library's input and writes straight back to the channel", () => {
		const probe = fakeChannel();
		const stdin = input();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: stdin,
		});
		expect(connection.input).toBe(stdin);
		connection.output.write("a frame");
		expect(probe.written()).toBe("a frame");
	});

	test("carries no actor until one is bound to it", () => {
		const connection = attachDoorConnection({
			cap: CAP,
			channel: fakeChannel().channel,
			input: input(),
		});
		expect("actor" in connection).toBe(false);
		expect(sessionForActor(connection, "abc").actor).toBe("abc");
	});

	test("announces the capped size, never the client's own", () => {
		const probe = fakeChannel(400, 150);
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		expect(connection.size()).toEqual({ columns: 300, rows: 100 });
		expect(connection.output.columns).toBe(300);
		expect(connection.output.rows).toBe(100);
	});

	test("caps every resize and hands listeners the capped size", () => {
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		const seen: { columns: number; rows: number }[] = [];
		const unsubscribe = connection.onResize((size) => seen.push(size));
		probe.resize(500, 200);
		expect(connection.size()).toEqual({ columns: 300, rows: 100 });
		probe.resize(100, 30);
		expect(connection.size()).toEqual({ columns: 100, rows: 30 });
		unsubscribe();
		probe.resize(90, 25);
		expect(seen).toEqual([
			{ columns: 300, rows: 100 },
			{ columns: 100, rows: 30 },
		]);
	});

	test("a bound session shares the connection's resize and size", () => {
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		const session = sessionForActor(connection, "abc");
		probe.resize(100, 30);
		expect(session.size()).toEqual({ columns: 100, rows: 30 });
	});

	test("a channel close subscriber arriving after close fires exactly once", () => {
		const probe = fakeChannel();
		probe.close();
		let closes = 0;
		const unsubscribe = probe.channel.onClose(() => {
			closes += 1;
		});
		unsubscribe();
		probe.close();
		expect(closes).toBe(1);
	});

	test("a connection close subscriber arriving after channel close fires", () => {
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		probe.close();
		let closes = 0;
		connection.onClose(() => {
			closes += 1;
		});
		expect(closes).toBe(1);
	});

	test("notifies close once when the connection closes before the channel", () => {
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		let closes = 0;
		connection.onClose(() => {
			closes += 1;
		});
		connection.close();
		probe.close();
		expect(closes).toBe(1);
	});

	test("notifies close once when the channel closes before the connection", () => {
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		let closes = 0;
		connection.onClose(() => {
			closes += 1;
		});
		probe.close();
		connection.close();
		expect(closes).toBe(1);
	});

	test("close() releases the screens but never ends the library's session", () => {
		// The Door ends the session itself, after the goodbye is written — a
		// close that tore the channel down here would race the farewell.
		const probe = fakeChannel();
		const connection = attachDoorConnection({
			cap: CAP,
			channel: probe.channel,
			input: input(),
		});
		connection.close();
		// Teardown left nothing subscribed to the library's session.
		expect(probe.resizeListeners()).toBe(0);
		expect(probe.closeListeners()).toBe(0);
		// The channel itself is still the library's to end.
		connection.output.write("goodbye");
		expect(probe.written()).toBe("goodbye");
	});
});

describe("holdDoorInput", () => {
	test("holds typed bytes from the consumer and releases them in arrival order", async () => {
		const probe = holdProbe();
		probe.held.hold();
		probe.stream.write("\u001B[Z");
		probe.stream.write("hello\r");
		await Bun.sleep(0);
		// The seat claim may already be on the log here (#130): nothing reaches
		// the consumer until the Table's routes exist.
		expect(probe.seen).toEqual([]);
		probe.held.release();
		await Bun.sleep(0);
		expect(probe.seen.join("")).toBe("\u001B[Zhello\r");
	});

	test("discard drops what the hold caught and hands the stream back flowing", async () => {
		const probe = holdProbe();
		probe.held.hold();
		probe.stream.write("typed at a table that never became ready");
		await Bun.sleep(0);
		probe.held.discard();
		await Bun.sleep(0);
		// Never delivered late, never replayed at the next screen (#130).
		expect(probe.seen).toEqual([]);
		// The drain detached the consumer to keep read() from emitting to it;
		// the hand-back must leave the same consumer attached and flowing.
		probe.stream.write("a lobby key");
		await Bun.sleep(0);
		expect(probe.seen.join("")).toBe("a lobby key");
	});

	test("re-engages after an entry interlude legitimately consumed a key", async () => {
		const probe = holdProbe();
		probe.held.hold();
		probe.stream.write("x");
		// The guest upgrade box's awaitKeypress resumes the stream itself and
		// takes the dismissing key; that consumption is the box's right.
		probe.stream.resume();
		await Bun.sleep(0);
		expect(probe.seen.join("")).toBe("x");
		probe.seen.length = 0;
		// runRoomTable re-engages the hold for the stretch to Table readiness.
		probe.held.hold();
		probe.stream.write("for the table");
		await Bun.sleep(0);
		expect(probe.seen).toEqual([]);
		probe.held.release();
		await Bun.sleep(0);
		expect(probe.seen.join("")).toBe("for the table");
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
