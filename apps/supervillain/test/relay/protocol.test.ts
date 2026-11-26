import { describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

import { Effect, Fiber, Predicate } from "effect";

import {
	addressText,
	claimProof,
	crockford,
	DEFAULT_RELAY,
	DEFAULT_RELAY_PLAYER_PORT,
	errLine,
	HANDLE,
	helloLine,
	isHandle,
	isPairingCode,
	isReservedHandle,
	isReservedShortTable,
	isTableName,
	KNOWS_NONCE_BYTES,
	KNOWS_SUBSYSTEM,
	knowsAnswerLine,
	knowsQueryLine,
	knownActor,
	LineError,
	MAX_KNOWS_ANSWER_BYTES,
	MAX_LINE_BYTES,
	parseAddress,
	parseAnswer,
	parseHello,
	parseKnowsAnswer,
	parseKnowsQuery,
	PROTOCOL_VERSION,
	provesClaim,
	readLine,
	RELAYED_INVITE_ENV,
	RESERVED_HANDLES,
	RESERVED_SHORT_TABLES,
	TABLE,
} from "../../src/relay/protocol.ts";
import { effect, must } from "../host/effect.ts";

describe("the hello line", () => {
	test("names a handle and a table, in protocol 2", () => {
		expect(helloLine("ana", "den")).toBe("SUPERVILLAIN 2 TABLE ana/den\n");
		expect(parseHello("SUPERVILLAIN 2 TABLE ana/den")).toEqual({
			ok: true,
			handle: "ana",
			table: "den",
		});
		expect(
			parseHello(
				`SUPERVILLAIN 2 TABLE a${"b-9".repeat(7)}/a${"b-9".repeat(10)}c`
			)
		).toEqual({
			ok: true,
			handle: `a${"b-9".repeat(7)}`,
			table: `a${"b-9".repeat(10)}c`,
		});
		expect(parseHello(helloLine("x", "y").slice(0, -1))).toEqual({
			ok: true,
			handle: "x",
			table: "y",
		});
	});

	test("may carry a key-bound proof of a claim code, never the code itself", () => {
		const code = "sv-0123456789abcdefghjk";
		const key = `SHA256:${"A".repeat(43)}`;
		const other = `SHA256:${"B".repeat(43)}`;
		const proof = claimProof(code, key);
		expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(helloLine("ana", "den", proof)).toBe(
			`SUPERVILLAIN 2 TABLE ana/den CLAIM ${proof}\n`
		);
		expect(helloLine("ana", "den", proof)).not.toContain(code);
		expect(parseHello(helloLine("ana", "den", proof).slice(0, -1))).toEqual({
			ok: true,
			handle: "ana",
			table: "den",
			proof,
		});
		expect(provesClaim(code, key, proof)).toBe(true);
		expect(provesClaim(code, other, proof)).toBe(false);
		expect(provesClaim("sv-zzzzzzzzzzzzzzzzzzzz", key, proof)).toBe(false);
		expect(provesClaim(code, key, "short")).toBe(false);
		expect(parseHello(`SUPERVILLAIN 2 TABLE ana/den CLAIM ${code}`).ok).toBe(
			false
		);
		expect(
			Buffer.byteLength(
				helloLine("a".repeat(24), "b".repeat(32), claimProof(code, key))
			)
		).toBeLessThanOrEqual(MAX_LINE_BYTES);
	});

	test("a protocol 1 host is told to upgrade", () => {
		const v1 = parseHello("SUPERVILLAIN 1 ROOM den");
		expect(v1.ok).toBe(false);

		if (!v1.ok) {
			expect(v1.reason).toContain("protocol 2");
			expect(v1.reason).toContain("upgrade supervillain");
		}
	});

	test("anything else is refused with a reason", () => {
		for (const line of [
			"",
			"GET / HTTP/1.1",
			"SSH-2.0-OpenSSH_9.9",
			"SUPERVILLAIN 3 TABLE ana/den",
			"SUPERVILLAIN 2 TABLE",
			"SUPERVILLAIN 2 TABLE ",
			"SUPERVILLAIN 2 TABLE den",
			"SUPERVILLAIN 2 TABLE ana/den\r",
			"SUPERVILLAIN 2 TABLE ana/den extra",
			"SUPERVILLAIN 2 TABLE  ana/den",
			"SUPERVILLAIN 2 TABLE Ana/den",
			"SUPERVILLAIN 2 TABLE ana/9den",
			"SUPERVILLAIN 2 TABLE -ana/den",
			"SUPERVILLAIN 2 TABLE ana/den_1",
			"SUPERVILLAIN 2 TABLE ana/dën",
			"SUPERVILLAIN 2 TABLE ana/den/more",
			`SUPERVILLAIN 2 TABLE ana/a${"b".repeat(32)}`,
			`SUPERVILLAIN 2 TABLE a${"b".repeat(24)}/den`,
			"supervillain 2 table ana/den",
		]) {
			const parsed = parseHello(line);
			expect(parsed.ok).toBe(false);

			if (!parsed.ok) {
				expect(parsed.reason.length).toBeGreaterThan(0);
			}
		}
	});

	test("handles are 1-24 and tables 1-32 of a-z, 0-9 and -, starting with a letter", () => {
		expect(isHandle("a")).toBe(true);
		expect(isHandle(`a${"0".repeat(23)}`)).toBe(true);
		expect(isHandle(`a${"0".repeat(24)}`)).toBe(false);
		expect(isTableName(`a${"0".repeat(31)}`)).toBe(true);
		expect(isTableName(`a${"0".repeat(32)}`)).toBe(false);
		expect(isTableName("")).toBe(false);
		expect(HANDLE.test("ana-2")).toBe(true);
		expect(TABLE.test("first-fight")).toBe(true);
	});

	test("names ssh sends by default, and service words, are reserved handles and never shorthand", () => {
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
			expect(isReservedHandle(name)).toBe(true);
			expect(isReservedShortTable(name)).toBe(true);
			expect(RESERVED_HANDLES.has(name)).toBe(true);
			expect(RESERVED_SHORT_TABLES.has(name)).toBe(true);
		}

		for (const name of ["den", "first-fight", "rootcellar", "pirates", "ana"]) {
			expect(isReservedHandle(name)).toBe(false);
		}

		expect(parseHello("SUPERVILLAIN 2 TABLE root/den")).toEqual({
			ok: false,
			reason: "the handle root is reserved: pick another",
		});
	});
});

describe("a player's address", () => {
	test("is handle/table, handle.table, or a bare table for the shorthand", () => {
		expect(parseAddress("ana/den")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
		});
		expect(parseAddress("ana.den")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
		});
		expect(parseAddress("Ana/Den")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
		});
		expect(parseAddress("den")).toEqual({ kind: "short", table: "den" });
	});

	test("an invite after ~ is stripped off before routing", () => {
		expect(parseAddress("ana/den~k3y9")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
			invite: "k3y9",
		});
		expect(parseAddress("den~k3y9")).toEqual({
			kind: "short",
			table: "den",
			invite: "k3y9",
		});
		expect(parseAddress("ana/den~")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
		});
		expect(parseAddress("ana/den~no spaces")).toEqual({
			kind: "table",
			handle: "ana",
			table: "den",
		});
	});

	test("anything else names no table", () => {
		for (const user of [
			"",
			"ana/",
			"/den",
			"ana/den/x",
			"9ana/den",
			"ana/9den",
			"dën",
			`${"a".repeat(25)}/den`,
		]) {
			expect(parseAddress(user).kind).toBe("none");
		}

		expect(addressText("ana", "den")).toBe("ana/den");
	});
});

describe("codes", () => {
	test("Crockford base32 is lowercase, unambiguous, and the length asked", () => {
		expect(crockford(new Uint8Array([0, 0, 0]), 4)).toBe("0000");
		expect(crockford(new Uint8Array([255, 255, 255]), 4)).toBe("zzzz");
		expect(crockford(new Uint8Array([0b0000_1000, 0b0100_0010]), 3)).toBe(
			"111"
		);

		for (const char of crockford(new Uint8Array(32).fill(173), 40)) {
			expect("ilou").not.toContain(char);
		}
	});

	test("a pairing code is sv- and 20 of them", () => {
		expect(isPairingCode("sv-0123456789abcdefghjk")).toBe(true);
		expect(isPairingCode("sv-0123456789abcdefghji")).toBe(false);
		expect(isPairingCode(`sv-${"0".repeat(19)}`)).toBe(false);
		expect(isPairingCode(`SV-${"0".repeat(20)}`)).toBe(false);
	});

	test("the defaults point players at the public relay on port 22", () => {
		expect(DEFAULT_RELAY).toBe("supervillain.sh:7022");
		expect(DEFAULT_RELAY_PLAYER_PORT).toBe(22);
		expect(PROTOCOL_VERSION).toBe(2);
		expect(RELAYED_INVITE_ENV).toBe("SV_INVITE");
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
				near.write(`${helloLine("ana", "den")}SSH-2.0-test\r\nmore`);
				expect(yield* readLine(far)).toBe("SUPERVILLAIN 2 TABLE ana/den");
				expect(yield* restOf(far, "more")).toBe("SSH-2.0-test\r\nmore");
			})
	);

	effect("a line split across chunks is joined", () =>
		Effect.gen(function* () {
			const { near, far } = yield* pair;
			near.write("SUPERVILLAIN 2 ");

			setTimeout(() => {
				near.write("TABLE ana/den\n");
			}, 30);

			expect(yield* readLine(far)).toBe("SUPERVILLAIN 2 TABLE ana/den");
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
