import { describe, expect, test } from "bun:test";

import { Effect, Layer, Logger } from "effect";

import { answerKnows } from "../../src/host/lobby.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import { JOIN_HINT, knowsQueryLine } from "../../src/relay/protocol.ts";
import { startRelay } from "../relay/harness.ts";
import { clientKey, sshExec, sshShell } from "../relay/openssh.ts";
import { effect, waitFor } from "./effect.ts";
import { tempDir } from "./tempDir.ts";

const VEX = `key:SHA256:${"v".repeat(43)}`;

const KAI = `key:SHA256:${"k".repeat(43)}`;

const asking = (actor: string) =>
	knowsQueryLine(actor, crypto.getRandomValues(new Uint8Array(16))).trimEnd();

describe("the table's answer to the lobby", () => {
	test("yes, with who's seated, for a key among the table's actors; no otherwise", () => {
		expect(answerKnows(asking(VEX), ["gm", VEX], 2, true)).toEqual({
			answer: { known: true, seated: 2 },
			actor: VEX,
		});
		expect(answerKnows(asking(KAI), ["gm", VEX], 2, true)).toEqual({
			answer: { known: false },
		});
		expect(answerKnows("garbage", [VEX], 2, true)).toEqual({
			answer: { known: false },
		});
		expect(answerKnows(undefined, [VEX], 2, true)).toEqual({
			answer: { known: false },
		});
	});

	test("always no with the lobby off", () => {
		expect(answerKnows(asking(VEX), [VEX], 2, false)).toEqual({
			answer: { known: false },
		});
	});
});

const relayedTable = (
	relay: Effect.Success<ReturnType<typeof startRelay>>,
	room: string,
	lobby?: boolean
) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;

		const layer = TableServer.layer({
			campaignDir: dir,
			room,
			port: 0,
			bind: "127.0.0.1",
			lobby: lobby ?? true,
			relay: {
				host: "127.0.0.1",
				port: relay.gmPort,
				relayKey: relay.relayKeyFingerprint,
			},
		}).pipe(Layer.provideMerge(tableServices(dir)));

		yield* Layer.build(layer.pipe(Layer.provide(Logger.layer([]))));
		yield* waitFor(
			`room ${room} linked`,
			() => relay.linkedRooms().includes(room),
			10_000
		);
	});

describe("a table behind a relay, in the lobby", () => {
	effect(
		"is listed for a key that has written to its log, not for one that hasn't; --no-lobby never",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* relayedTable(relay, "den");
				yield* relayedTable(relay, "keep", false);
				const keys = yield* tempDir;
				const vex = yield* clientKey(keys, "vex");
				const kai = yield* clientKey(keys, "kai");

				const lobby = (key: typeof vex) =>
					sshExec(relay.playerPort, ["help"], { key, user: "lobby" });

				expect((yield* lobby(vex)).stderr).toBe(`${JOIN_HINT}\n`);

				for (const user of ["den", "keep"]) {
					expect(
						(yield* sshExec(relay.playerPort, ["roll", "1d6"], {
							key: vex,
							user,
						})).exitCode
					).toBe(0);
				}

				const listed = yield* lobby(vex);
				expect(listed.exitCode).toBe(1);
				expect(listed.stderr).toMatch(
					/^Your table open now: den \(0 seated\)\.\n/u
				);
				expect((yield* lobby(kai)).stderr).toBe(`${JOIN_HINT}\n`);
			}),
		30_000
	);

	effect(
		"is listed for a key seated there now, before it has written anything",
		() =>
			Effect.gen(function* () {
				const relay = yield* startRelay();
				yield* relayedTable(relay, "den");
				const kai = yield* clientKey(yield* tempDir, "kai");

				const lobby = () =>
					sshExec(relay.playerPort, ["help"], { key: kai, user: "lobby" });

				yield* Effect.scoped(
					Effect.gen(function* () {
						const seat = yield* sshShell(
							relay.playerPort,
							{ cols: 100, rows: 30 },
							{
								key: kai,
								user: "den",
							}
						);

						yield* waitFor(
							"the table drawn",
							() => seat.output().length > 200,
							10_000
						);
						const listed = yield* lobby();
						expect(listed.exitCode).toBe(1);
						expect(listed.stderr).toMatch(
							/^Your table open now: den \(1 seated\)\.\n/u
						);
					})
				);
				yield* Effect.sleep("500 millis");
				expect((yield* lobby()).stderr).toBe(`${JOIN_HINT}\n`);
			}),
		30_000
	);
});
