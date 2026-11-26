import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
	NO_SANDBOXES,
	SANDBOX_CLOSING,
	sandboxGate,
	sandboxLimits,
	sizeProblem,
} from "../../src/relay/sandbox.ts";
import type { RelayOptions } from "../../src/relay/server.ts";
import { effect, waitFor } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";
import { startRelay } from "./harness.ts";
import { clientKey, sshShell } from "./openssh.ts";
import type { ClientKey } from "./openssh.ts";

const SIZE = { cols: 100, rows: 30 };

const SET_UP = "Bandit Bruiser is placed at h5.";

const shown = (terminal: { output: () => string }) =>
	Bun.stripANSI(terminal.output());

type Relay = Effect.Success<ReturnType<typeof startRelay>>;

const tryTab = (
	relay: Relay,
	key: ClientKey | undefined,
	size: { cols: number; rows: number } = SIZE
) =>
	Effect.gen(function* () {
		const terminal = yield* sshShell(
			relay.playerPort,
			size,
			key === undefined ? { user: "lobby" } : { key, user: "lobby" }
		);

		yield* waitFor("the lobby", () =>
			shown(terminal).includes("> type your table's name")
		);
		terminal.write("\u001BOQ");
		yield* waitFor("the try tab", () =>
			shown(terminal).includes("a Draw Steel table to play by yourself")
		);

		return terminal;
	});

const sandboxOn = (relay: Relay, key: ClientKey | undefined) =>
	Effect.gen(function* () {
		const terminal = yield* tryTab(relay, key);
		terminal.write("\r");
		yield* waitFor(
			"the sandbox table",
			() => shown(terminal).includes(SET_UP),
			10_000
		);

		return terminal;
	});

const startWith = (sandbox: RelayOptions["sandbox"]) =>
	startRelay(sandbox === undefined ? {} : { sandbox });

describe("relay: try a table", () => {
	effect(
		"F2 and Enter open a private sandbox table, set up and live; Ctrl-C closes it",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const vex = yield* clientKey(yield* tempDir, "vex");
				const terminal = yield* sandboxOn(relay, vex);
				const table = shown(terminal);
				expect(table).toContain("supervillain · try");
				expect(table).toContain("The Ford Road");
				expect(table).toContain("Brann is placed at b5.");
				expect(table).toContain("Ilsa is placed at b7.");
				expect(table).toContain("Bandit Chief is placed at p5.");
				expect(relay.sandboxesLive()).toBe(1);
				terminal.write("/roll 2d10\r");
				yield* waitFor("the roll", () => /rolled 2d10/u.test(shown(terminal)));
				terminal.write("\u0003");
				expect(yield* Effect.promise(async () => await terminal.exited)).toBe(
					0
				);
				yield* waitFor(
					"the sandbox released",
					() => relay.sandboxesLive() === 0
				);
			}),
		20_000
	);

	effect(
		"one sandbox to a key and to an address, and only so many at once",
		() =>
			Effect.gen(function* () {
				const relay = yield* startWith({ live: 2, perAddress: 2 });
				const dir = yield* tempDir;
				const vex = yield* clientKey(dir, "vex");
				const kai = yield* clientKey(dir, "kai");
				yield* sandboxOn(relay, vex);

				const again = yield* tryTab(relay, vex);
				again.write("\r");
				yield* waitFor("the key's refusal", () =>
					shown(again).includes(
						"› Your key has a sandbox table open already; close that one first."
					)
				);

				yield* sandboxOn(relay, kai);
				expect(relay.sandboxesLive()).toBe(2);

				const guest = yield* tryTab(relay, undefined);
				guest.write("\r");
				yield* waitFor("the full refusal", () =>
					shown(guest).includes("› Every sandbox table is in use (2)")
				);

				const narrow = yield* startWith({ live: 4 });
				yield* sandboxOn(narrow, vex);
				const second = yield* tryTab(narrow, kai);
				second.write("\r");
				yield* waitFor("the address refusal", () =>
					shown(second).includes(
						"› Your address has a sandbox table open already"
					)
				);
			}),
		30_000
	);

	effect(
		"a terminal smaller than 100×30 is told so, and stays in the lobby",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				const small = yield* tryTab(relay, undefined, { cols: 90, rows: 28 });
				small.write("\r");
				yield* waitFor("the size refusal", () =>
					shown(small).includes(
						"› Try a Table needs a terminal of at least 100×30; this one is 90×28."
					)
				);
				expect(relay.sandboxesLive()).toBe(0);
				small.resize(120, 40);
				yield* Effect.sleep("200 millis");
				small.write("\r");
				yield* waitFor(
					"the sandbox table",
					() => shown(small).includes(SET_UP),
					10_000
				);
			}),
		20_000
	);

	effect("--sandboxes 0 turns them off", () =>
		Effect.gen(function* () {
			const relay = yield* startWith({ live: 0 });
			const terminal = yield* tryTab(relay, undefined);
			expect(shown(terminal)).toContain("this relay offers no sandbox tables");
			terminal.write("\r");
			yield* waitFor("the refusal", () =>
				shown(terminal).includes(`› ${NO_SANDBOXES}`)
			);
		})
	);

	effect(
		"an idle sandbox closes itself, and so does one past its time, warning first",
		() =>
			Effect.gen(function* () {
				const idle = yield* startWith({ idleMs: 1500 });
				const quiet = yield* sandboxOn(idle, undefined);
				expect(yield* Effect.promise(async () => await quiet.exited)).toBe(0);
				yield* waitFor("idle released", () => idle.sandboxesLive() === 0);
				expect(idle.logs.some((l) => l.includes("closed, idle"))).toBe(true);

				const timed = yield* startWith({ maxMs: 2500, warnMs: 1500 });
				const late = yield* sandboxOn(timed, undefined);
				yield* waitFor(
					"the warning",
					() => shown(late).includes(SANDBOX_CLOSING),
					4000
				);
				expect(yield* Effect.promise(async () => await late.exited)).toBe(0);
				expect(
					timed.logs.some((l) => l.includes("closed, its time ran out"))
				).toBe(true);
			}),
		30_000
	);

	effect(
		"a sandbox's lines are rate-limited, its log is capped, and a broken one leaves the relay serving",
		() =>
			Effect.gen(function* () {
				const slow = yield* startWith({ rate: { burst: 1, perSecond: 0.001 } });
				const rated = yield* sandboxOn(slow, undefined);
				rated.write("/roll 2d10\r");
				yield* waitFor("the roll", () => /rolled 2d10/u.test(shown(rated)));
				rated.write("/roll 2d10\r");
				yield* waitFor("the throttle", () =>
					shown(rated).includes("You're sending lines too fast")
				);

				const capped = yield* startWith({ logCap: 3 });
				const full = yield* tryTab(capped, undefined);
				full.write("\r");
				yield* waitFor(
					"the table",
					() => shown(full).includes("supervillain · try"),
					10_000
				);
				full.write("/roll 2d10\r");
				yield* waitFor("the halt", () =>
					shown(full).includes("room is halted")
				);

				const bad = yield* tempDir;
				yield* Effect.promise(
					async () => await Bun.write(`${bad}/campaign.yaml`, "rules: chess\n")
				);
				const broken = yield* startWith({ campaignDir: bad });
				const failed = yield* tryTab(broken, undefined);
				failed.write("\r");
				yield* Effect.promise(async () => await failed.exited);
				yield* waitFor(
					"the sandbox released",
					() => broken.sandboxesLive() === 0
				);
				expect(
					broken.logs.some((l) => l.includes("sandbox: the table failed"))
				).toBe(true);
				const after = yield* tryTab(broken, undefined);
				expect(shown(after)).toContain("Try a Table");
			}),
		30_000
	);
});

describe("the sandbox gate", () => {
	test("admits up to its caps, and a release frees a place once", () => {
		const gate = sandboxGate(
			sandboxLimits({ live: 2, perAddress: 1, perKey: 1 })
		);

		const first = gate.admit("10.0.0.1", "SHA256:a");
		expect(first.kind).toBe("in");
		expect(gate.admit("10.0.0.2", "SHA256:a")).toMatchObject({ kind: "out" });
		expect(gate.admit("10.0.0.1", undefined)).toMatchObject({ kind: "out" });
		const second = gate.admit("10.0.0.2", undefined);
		expect(second.kind).toBe("in");
		expect(gate.admit("10.0.0.3", undefined)).toEqual({
			kind: "out",
			reason: "Every sandbox table is in use (2); try again in a few minutes.",
		});
		expect(gate.live()).toBe(2);

		if (first.kind === "in") {
			first.release();
			first.release();
		}

		expect(gate.live()).toBe(1);
		expect(gate.admit("10.0.0.1", "SHA256:a").kind).toBe("in");
		expect(
			sandboxGate(sandboxLimits({ live: 0 })).admit("10.0.0.1", undefined)
		).toEqual({
			kind: "out",
			reason: NO_SANDBOXES,
		});
	});

	test("the size check names the least it needs", () => {
		const limits = sandboxLimits();
		expect(sizeProblem(100, 30, limits)).toBeUndefined();
		expect(sizeProblem(99, 40, limits)).toContain(
			"at least 100×30; this one is 99×40"
		);
		expect(limits).toMatchObject({
			live: 12,
			perAddress: 1,
			perKey: 1,
			idleMs: 300_000,
			maxMs: 1_200_000,
			logCap: 2000,
		});
	});
});
