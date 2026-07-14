/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member, eslint/sort-keys -- dual-lane suite with sequential command assertions. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry, TableView } from "@supervillain/core";

import { decide } from "../../games/fake/src/authority.js";
import { apply, init } from "../../games/fake/src/model.js";
import { RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const table: TableView = {
	gmSeatId: "gm",
	seats: [{ actor: "gm-key", id: "gm" }],
};
const registry: HostRegistry = {
	get: (id) =>
		id === "fake"
			? { authority: { decide }, model: { apply, init } }
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
			table,
		});
		await run(host, folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

describe("RoomHost core commands", () => {
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
				table,
			});
			const result = await reopened.submit({
				actor: "gm-key",
				command: { notation: "d6", type: "core.roll" },
			});
			expect(result).toMatchObject({ accepted: true, envelopes: [{ seq: 5 }] });
			const lines = (await readFile(path.join(folder, "events.jsonl"), "utf-8"))
				.trim()
				.split("\n")
				.map(JSON.parse);
			expect(lines.map((line) => line.type)).toEqual([
				"core.room-created",
				"core.chat-posted",
				"fake.seat-observed",
				"fake.visit-counted",
				"core.dice-rolled",
			]);
		}));
});
