/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member, eslint/sort-keys -- dual-lane suite with sequential command assertions. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import { apply, eventTypes, init } from "../../games/fake/src/model.js";
import { RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const registry: HostRegistry = {
	get: (id) =>
		id === "fake"
			? {
					authority: { decide },
					grammar: { eventTypes },
					model: { apply, init },
				}
			: undefined,
};
const withHost = async (
	run: (host: RoomHost, folder: string) => Promise<void>,
	random = () => 0.5
) => {
	const folder = await mkdtemp(
		path.join(tmpdir(), "supervillain-core-commands-")
	);
	try {
		const host = await RoomHost.open({
			actor: "gm-key",
			campaignFolder: folder,
			gameId: "fake",
			random,
			registry,
		});
		await run(host, folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

describe("RoomHost core commands", () => {
	test("claims sequential seats and makes repeated claims idempotent", async () =>
		withHost(async (host, folder) => {
			const first = await host.submit({
				actor: "player-one",
				command: { type: "core.claim-seat" },
			});
			expect(first).toMatchObject({
				accepted: true,
				envelopes: [
					{
						actor: "player-one",
						payload: { seatId: "player-1" },
						seq: 3,
						type: "core.seat-claimed",
					},
				],
			});
			expect(
				await host.submit({
					actor: "player-two",
					command: { type: "core.claim-seat" },
				})
			).toMatchObject({
				accepted: true,
				envelopes: [{ payload: { seatId: "player-2" }, seq: 4 }],
			});
			expect(
				await host.submit({
					actor: "player-one",
					command: { type: "core.claim-seat" },
				})
			).toEqual({ accepted: true, envelopes: [] });
			expect(host.snapshot().table).toEqual({
				actor: "",
				gmSeatId: "gm",
				seats: [
					{ actor: "gm-key", characterId: null, id: "gm" },
					{ actor: "player-one", characterId: null, id: "player-1" },
					{ actor: "player-two", characterId: null, id: "player-2" },
				],
			});
			const lines = (await readFile(path.join(folder, "events.jsonl"), "utf-8"))
				.trim()
				.split("\n");
			expect(lines).toHaveLength(4);
		}));

	test("binds the issuer's seat with validation and idempotence", async () =>
		withHost(async (host, folder) => {
			expect(
				await host.submit({
					actor: "stranger",
					command: { characterId: "hero", type: "core.bind-character" },
				})
			).toEqual({
				message: "You do not hold a seat at this table.",
				rejected: true,
			});
			for (const characterId of ["", "   ", "x".repeat(61)]) {
				expect(
					await host.submit({
						actor: "gm-key",
						command: { characterId, type: "core.bind-character" },
					})
				).toEqual({
					message:
						"Character id must be a non-empty string of at most 60 characters.",
					rejected: true,
				});
			}
			const bound = await host.submit({
				actor: "gm-key",
				command: { characterId: "  hero  ", type: "core.bind-character" },
			});
			expect(bound).toMatchObject({
				accepted: true,
				envelopes: [
					{
						actor: "gm-key",
						payload: { characterId: "hero", seatId: "gm" },
						seq: 3,
						type: "core.character-bound",
					},
				],
			});
			expect(
				await host.submit({
					actor: "gm-key",
					command: { characterId: "hero", type: "core.bind-character" },
				})
			).toEqual({ accepted: true, envelopes: [] });
			expect(host.snapshot().table.seats[0]?.characterId).toBe("hero");
			const stream = host.stream(1)[Symbol.asyncIterator]();
			await stream.next();
			await stream.next();
			expect((await stream.next()).value).toMatchObject({
				payload: { characterId: "hero", seatId: "gm" },
				type: "core.character-bound",
			});
			await stream.return?.();

			const reopened = await RoomHost.open({
				campaignFolder: folder,
				registry,
			});
			expect(reopened.snapshot().table.seats[0]?.characterId).toBe("hero");
			expect(
				await reopened.submit({
					actor: "gm-key",
					command: { characterId: null, type: "core.bind-character" },
				})
			).toMatchObject({
				accepted: true,
				envelopes: [{ payload: { characterId: null, seatId: "gm" }, seq: 4 }],
			});
			expect(
				await reopened.submit({
					actor: "gm-key",
					command: { characterId: null, type: "core.bind-character" },
				})
			).toEqual({ accepted: true, envelopes: [] });
		}));

	test("posts trimmed chat and validates messages and seats", async () =>
		withHost(async (host) => {
			expect(
				await host.submit({
					actor: "gm-key",
					command: { text: "  hello  ", type: "core.chat" },
				})
			).toMatchObject({
				accepted: true,
				envelopes: [{ payload: { text: "hello" }, type: "core.chat-posted" }],
			});
			expect(
				await host.submit({
					actor: "gm-key",
					command: { text: "  ", type: "core.chat" },
				})
			).toEqual({ message: "Chat message is empty.", rejected: true });
			expect(
				await host.submit({
					actor: "gm-key",
					command: { text: "x".repeat(1001), type: "core.chat" },
				})
			).toEqual({ message: "Chat message is too long.", rejected: true });
			expect(
				await host.submit({
					actor: "stranger",
					command: { text: "hello", type: "core.chat" },
				})
			).toEqual({
				message: "You do not hold a seat at this table.",
				rejected: true,
			});
		}));

	test("rolls deterministic canonical dice including default count", async () => {
		const values = [0, 0.5, 0.95];
		let index = 0;
		await withHost(
			async (host) => {
				expect(
					await host.submit({
						actor: "gm-key",
						command: { notation: " 2D6 + 1 ", type: "core.roll" },
					})
				).toMatchObject({
					accepted: true,
					envelopes: [
						{
							payload: {
								modifier: 1,
								notation: "2d6+1",
								rolls: [1, 4],
								total: 6,
							},
							type: "core.dice-rolled",
						},
					],
				});
				expect(
					await host.submit({
						actor: "gm-key",
						command: { notation: "d20", type: "core.roll" },
					})
				).toMatchObject({
					accepted: true,
					envelopes: [
						{
							payload: { modifier: 0, notation: "d20", rolls: [20], total: 20 },
						},
					],
				});
			},
			() => {
				const value = values[index] ?? 0;
				index += 1;
				return value;
			}
		);
	});

	test("rejects invalid and unknown core commands", async () =>
		withHost(async (host) => {
			for (const notation of ["0d6", "21d6", "2d1", "d6+1001", "garbage"]) {
				expect(
					await host.submit({
						actor: "gm-key",
						command: { notation, type: "core.roll" },
					})
				).toEqual({
					message: `Cannot roll '${notation}'. Use NdS or NdS+M, e.g. 2d6+1.`,
					rejected: true,
				});
			}
			expect(
				await host.submit({ actor: "gm-key", command: { type: "core.nope" } })
			).toEqual({
				message: "Unknown core command 'core.nope'.",
				rejected: true,
			});
		}));

	test("replays interleaved core and game envelopes and resumes sequence", async () =>
		withHost(async (host, folder) => {
			await host.submit({
				actor: "gm-key",
				command: { text: "one", type: "core.chat" },
			});
			await host.submit({
				actor: "gm-key",
				command: { seatId: "gm", type: "fake.visit" },
			});
			const reopened = await RoomHost.open({
				campaignFolder: folder,
				random: () => 0,
				registry,
			});
			const result = await reopened.submit({
				actor: "gm-key",
				command: { notation: "d6", type: "core.roll" },
			});
			expect(result).toMatchObject({ accepted: true, envelopes: [{ seq: 6 }] });
			const lines = (await readFile(path.join(folder, "events.jsonl"), "utf-8"))
				.trim()
				.split("\n")
				.map(JSON.parse);
			expect(lines.map((line) => line.type)).toEqual([
				"core.room-created",
				"core.seat-claimed",
				"core.chat-posted",
				"fake.seat-observed",
				"fake.visit-counted",
				"core.dice-rolled",
			]);
		}));
});
