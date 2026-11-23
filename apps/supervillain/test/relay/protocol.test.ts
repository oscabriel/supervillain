import { describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

import { Effect, Fiber, Predicate } from "effect";

import {
	errLine,
	helloLine,
	isReservedRoom,
	isRoomName,
	KNOWS_NONCE_BYTES,
	KNOWS_SUBSYSTEM,
	knowsAnswerLine,
	knowsQueryLine,
	knownActor,
	LineError,
	MAX_KNOWS_ANSWER_BYTES,
	MAX_LINE_BYTES,
	parseAnswer,
	parseHello,
	parseKnowsAnswer,
	parseKnowsQuery,
	readLine,
} from "../../src/relay/protocol.ts";
import { effect, must } from "../host/effect.ts";

describe("the hello line", () => {
	test("names a room in the one version there is", () => {
		expect(helloLine("den")).toBe("SUPERVILLAIN 1 ROOM den\n");
		expect(parseHello("SUPERVILLAIN 1 ROOM den")).toEqual({
			ok: true,
			room: "den",
		});
		expect(parseHello(`SUPERVILLAIN 1 ROOM a${"b-9".repeat(10)}c`)).toEqual({
			ok: true,
			room: `a${"b-9".repeat(10)}c`,
		});
		expect(parseHello(helloLine("x").slice(0, -1))).toEqual({
			ok: true,
			room: "x",
		});
	});

	test("anything else is refused with a reason", () => {
		for (const line of [
			"",
			"GET / HTTP/1.1",
			"SSH-2.0-OpenSSH_9.9",
			"SUPERVILLAIN 2 ROOM den",
			"SUPERVILLAIN 1 ROOM",
			"SUPERVILLAIN 1 ROOM ",
			"SUPERVILLAIN 1 ROOM den\r",
			"SUPERVILLAIN 1 ROOM den extra",
			"SUPERVILLAIN 1 ROOM  den",
			"SUPERVILLAIN 1 ROOM Den",
			"SUPERVILLAIN 1 ROOM 9den",
			"SUPERVILLAIN 1 ROOM -den",
			"SUPERVILLAIN 1 ROOM den_1",
			"SUPERVILLAIN 1 ROOM dën",
			`SUPERVILLAIN 1 ROOM a${"b".repeat(32)}`,
			"supervillain 1 room den",
		]) {
			const parsed = parseHello(line);
			expect(parsed.ok).toBe(false);

			if (!parsed.ok) {
				expect(parsed.reason.length).toBeGreaterThan(0);
			}
		}
	});

	test("room names: 1-32 of a-z, 0-9 and -, starting with a letter", () => {
		expect(isRoomName("a")).toBe(true);
		expect(isRoomName(`a${"0".repeat(31)}`)).toBe(true);
		expect(isRoomName(`a${"0".repeat(32)}`)).toBe(false);
		expect(isRoomName("")).toBe(false);
	});

	test("names ssh sends by default, and service words, are reserved", () => {
		for (const name of [
			"root",
			"admin",
			"ubuntu",
			"pi",
			"ec2-user",
			"git",
			"lobby",
			"help",
			"watch",
		]) {
			expect(isReservedRoom(name)).toBe(true);
		}

		for (const name of ["den", "first-fight", "rootcellar", "pirates"]) {
			expect(isReservedRoom(name)).toBe(false);
		}

		expect(parseHello("SUPERVILLAIN 1 ROOM root")).toEqual({
			ok: false,
			reason: "room name root is reserved: pick another",
		});
	});
});

describe("the answer line", () => {
	test("OK, or ERR with a reason on one line", () => {
		expect(parseAnswer("OK")).toEqual({ ok: true });
		expect(errLine("busy\nOK")).toBe("ERR busy OK\n");
		expect(parseAnswer(errLine("room busy").slice(0, -1))).toEqual({
			ok: false,
			reason: "room busy",
		});
		expect(parseAnswer("OK SHA256:abc").ok).toBe(false);
		expect(parseAnswer("").ok).toBe(false);
	});
});

interface Pair {
	readonly near: Socket;
	readonly far: Socket;
	readonly close: () => void;
}

const pair = Effect.acquireRelease(
	Effect.callback<Pair>((resume) => {
		let dialed: Socket | undefined;

		const server = createServer((far) => {
			const near = must(dialed, "the near end connected first");

			resume(
				Effect.succeed({
					near,
					far,
					close: () => {
						near.destroy();
						far.destroy();
						server.close();
					},
				})
			);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();

			dialed = connect(
				address === null || Predicate.isString(address) ? 0 : address.port,
				"127.0.0.1"
			);
		});
	}),
	({ close }) => Effect.sync(close)
);

const restOf = (far: Socket, until: string) =>
	Effect.callback<string>((resume) => {
		let text = "";

		far.on("data", (chunk: Buffer) => {
			text += chunk.toString();

			if (text.endsWith(until)) {
				resume(Effect.succeed(text));
			}
		});

		far.resume();
	});

describe("readLine", () => {
	effect(
		"reads one line and leaves what follows for the next reader, even in one chunk",
		() =>
			Effect.gen(function* () {
				const { near, far } = yield* pair;
				near.write(`${helloLine("den")}SSH-2.0-test\r\nmore`);
				expect(yield* readLine(far)).toBe("SUPERVILLAIN 1 ROOM den");
				expect(yield* restOf(far, "more")).toBe("SSH-2.0-test\r\nmore");
			})
	);

	effect("a line split across chunks is joined", () =>
		Effect.gen(function* () {
			const { near, far } = yield* pair;
			near.write("SUPERVILLAIN 1 ");

			setTimeout(() => {
				near.write("ROOM den\n");
			}, 30);

			expect(yield* readLine(far)).toBe("SUPERVILLAIN 1 ROOM den");
		})
	);

	effect("an oversized line is refused without waiting for its end", () =>
		Effect.gen(function* () {
			const first = yield* pair;
			first.near.write("x".repeat(MAX_LINE_BYTES * 4));
			expect(yield* Effect.flip(readLine(first.far))).toBeInstanceOf(LineError);

			const second = yield* pair;
			second.near.write(`${"y".repeat(MAX_LINE_BYTES)}\n`);

			expect((yield* Effect.flip(readLine(second.far))).message).toContain(
				"line too long"
			);
		})
	);

	effect("silence times out; a peer that leaves first fails the read", () =>
		Effect.gen(function* () {
			const quiet = yield* pair;

			expect((yield* Effect.flip(readLine(quiet.far, 50))).message).toContain(
				"no line in time"
			);

			const gone = yield* pair;
			const reading = yield* Effect.forkChild(Effect.flip(readLine(gone.far)));
			yield* Effect.yieldNow;
			gone.near.end("partial");
			expect(yield* Fiber.join(reading)).toBeInstanceOf(LineError);
		})
	);
});

const nonce = (fill: number) => new Uint8Array(KNOWS_NONCE_BYTES).fill(fill);

describe("the lobby's question", () => {
	const VEX = `key:SHA256:${"v".repeat(43)}`;
	const KAI = `key:SHA256:${"k".repeat(43)}`;

	test("is a versioned subsystem: a host that doesn't serve this one refuses it", () => {
		expect(KNOWS_SUBSYSTEM).toBe("knows-1@supervillain.sh");
	});

	test("carries a nonce and a MAC of the key, never the key itself", () => {
		const line = knowsQueryLine(VEX, nonce(1));
		expect(line).toMatch(/^[A-Za-z0-9_-]{22} [A-Za-z0-9_-]{43}\n$/u);
		expect(line.length).toBeLessThan(MAX_LINE_BYTES);
		expect(line).not.toContain("SHA256");
		expect(line).not.toContain("v".repeat(8));
		expect(knowsQueryLine(VEX, nonce(2))).not.toBe(line);
		expect(knowsQueryLine(KAI, nonce(1)).split(" ")[1]).not.toBe(
			line.split(" ")[1]
		);
		expect(() => knowsQueryLine(VEX, new Uint8Array(8))).toThrow();
	});

	test("a host finds the key it's asked about among those it knows, and only keys", () => {
		const query = must(
			parseKnowsQuery(knowsQueryLine(VEX, nonce(3)).trimEnd()),
			"a well-formed question parses"
		);

		expect(knownActor(query, ["gm", KAI, VEX])).toBe(VEX);
		expect(knownActor(query, ["gm", KAI])).toBeUndefined();
		expect(knownActor(query, [])).toBeUndefined();

		const guest = must(
			parseKnowsQuery(knowsQueryLine("guest:abc", nonce(4)).trimEnd()),
			"a guest's question parses"
		);

		expect(knownActor(guest, ["guest:abc"])).toBeUndefined();
	});

	test("a malformed question is no question", () => {
		const good = knowsQueryLine(VEX, nonce(5)).trimEnd();
		const [n = "", mac = ""] = good.split(" ");

		for (const bad of [
			"",
			n,
			`${n}  ${mac}`,
			`${n} ${mac} x`,
			`${n} ${mac}\r`,
			`${n}= ${mac}`,
			`${n} ${mac.slice(1)}`,
			`${n.slice(1)} ${mac}`,
		]) {
			expect(parseKnowsQuery(bad)).toBeUndefined();
		}
	});

	test("the answer is yes with a count, or no; anything else reads as no", () => {
		expect(knowsAnswerLine({ known: true, seated: 3 })).toBe("yes 3\n");
		expect(knowsAnswerLine({ known: false })).toBe("no\n");
		expect(knowsAnswerLine({ known: true, seated: 123_456 })).toBe(
			"yes 9999\n"
		);
		expect(
			knowsAnswerLine({ known: true, seated: 9999 }).length
		).toBeLessThanOrEqual(MAX_KNOWS_ANSWER_BYTES);
		expect(parseKnowsAnswer("yes 3\n")).toEqual({ known: true, seated: 3 });
		expect(parseKnowsAnswer("yes 0")).toEqual({ known: true, seated: 0 });

		for (const other of [
			"no\n",
			"",
			"yes",
			"yes \n",
			"YES 3\n",
			"yes 3\nyes 4\n",
			"yes 12345\n",
			"maybe",
		]) {
			expect(parseKnowsAnswer(other)).toEqual({ known: false });
		}
	});
});
