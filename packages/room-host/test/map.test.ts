/* oxlint-disable vitest/prefer-importing-vitest-globals, unicorn/no-await-expression-member -- dual-lane suite with sequential command assertions. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const CAVERN = `name: Cavern Mouth
---
#####
#...#
#.^.#
##+##
`;

const openHost = async (folder: string): Promise<RoomHost> =>
	await RoomHost.open({
		actor: "gm-key",
		campaignFolder: folder,
		gameId: "fake",
		registry,
	});

const writeMap = async (
	folder: string,
	name: string,
	text: string
): Promise<void> => {
	await mkdir(path.join(folder, "maps"), { recursive: true });
	await writeFile(path.join(folder, "maps", `${name}.map`), text);
};

const withHost = async (
	run: (host: RoomHost, folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-map-"));
	try {
		await run(await openHost(folder), folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

describe("RoomHost battle maps", () => {
	test("captures the whole map file into one core.map-loaded event", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "cavern", CAVERN);
			const loaded = await host.submit({
				actor: "gm-key",
				command: { name: "cavern", type: "core.load-map" },
			});
			expect(loaded).toMatchObject({
				accepted: true,
				envelopes: [
					{
						actor: "gm-key",
						payload: {
							legend: {
								"#": "wall",
								"+": "door",
								".": "floor",
								"^": "hazard",
								"~": "difficult",
							},
							name: "Cavern Mouth",
							rows: ["#####", "#...#", "#.^.#", "##+##"],
						},
						seq: 3,
						type: "core.map-loaded",
					},
				],
			});
			expect(host.snapshot().map).toEqual({
				legend: {
					"#": "wall",
					"+": "door",
					".": "floor",
					"^": "hazard",
					"~": "difficult",
				},
				name: "Cavern Mouth",
				rows: ["#####", "#...#", "#.^.#", "##+##"],
			});
		}));

	test("rejects an invalid file and appends nothing", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "broken", "name: Broken\n---\n..\n.x.\n");
			const rejected = await host.submit({
				actor: "gm-key",
				command: { name: "broken", type: "core.load-map" },
			});
			expect(rejected).toEqual({
				message:
					"maps/broken.map: Row 2 is 3 cells wide; row 1 is 2. Every row must be the same width.",
				rejected: true,
			});
			expect(host.snapshot()).toMatchObject({ map: null, seq: 2 });
		}));

	test("rejects a map past the size bound and a missing file", async () =>
		await withHost(async (host, folder) => {
			await writeMap(
				folder,
				"huge",
				`name: Huge\n---\n${`${".".repeat(201)}\n`.repeat(2)}`
			);
			expect(
				await host.submit({
					actor: "gm-key",
					command: { name: "huge", type: "core.load-map" },
				})
			).toEqual({
				message: "maps/huge.map: Map grid is 201 cells wide; the limit is 200.",
				rejected: true,
			});
			expect(
				await host.submit({
					actor: "gm-key",
					command: { name: "absent", type: "core.load-map" },
				})
			).toEqual({
				message: "No map file at maps/absent.map.",
				rejected: true,
			});
			expect(host.snapshot().seq).toBe(2);
		}));

	test("refuses a map name that could escape the maps folder", async () =>
		await withHost(async (host) => {
			expect(
				await host.submit({
					actor: "gm-key",
					command: { name: "../events", type: "core.load-map" },
				})
			).toEqual({
				message:
					"Map names are 1-60 letters, digits, hyphens, and underscores.",
				rejected: true,
			});
			expect(host.snapshot().seq).toBe(2);
		}));

	test("lets the last load win and clears the surface", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "cavern", CAVERN);
			await writeMap(
				folder,
				"bog",
				"name: Bog\nlegend: o floor\n---\noo\noo\n"
			);
			await host.submit({
				actor: "gm-key",
				command: { name: "cavern", type: "core.load-map" },
			});
			await host.submit({
				actor: "gm-key",
				command: { name: "bog", type: "core.load-map" },
			});
			expect(host.snapshot().map).toEqual({
				legend: { o: "floor" },
				name: "Bog",
				rows: ["oo", "oo"],
			});
			expect(
				await host.submit({
					actor: "gm-key",
					command: { type: "core.clear-map" },
				})
			).toMatchObject({
				accepted: true,
				envelopes: [{ payload: {}, seq: 5, type: "core.map-cleared" }],
			});
			expect(host.snapshot().map).toBeNull();
			expect(
				await host.submit({
					actor: "gm-key",
					command: { type: "core.clear-map" },
				})
			).toEqual({ accepted: true, envelopes: [] });
		}));

	test("lets only the GM load or clear the map", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "cavern", CAVERN);
			await host.submit({
				actor: "player-one",
				command: { type: "core.claim-seat" },
			});
			expect(
				await host.submit({
					actor: "player-one",
					command: { name: "cavern", type: "core.load-map" },
				})
			).toEqual({
				message: "Only the GM can load or clear the battle map.",
				rejected: true,
			});
			expect(
				await host.submit({
					actor: "player-one",
					command: { type: "core.clear-map" },
				})
			).toEqual({
				message: "Only the GM can load or clear the battle map.",
				rejected: true,
			});
			expect(
				await host.submit({
					actor: "stranger",
					command: { name: "cavern", type: "core.load-map" },
				})
			).toEqual({
				message: "You do not hold a seat at this table.",
				rejected: true,
			});
			expect(host.snapshot().map).toBeNull();
		}));

	test("replays the map from the log alone, with no map file on disk", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "cavern", CAVERN);
			await host.submit({
				actor: "gm-key",
				command: { name: "cavern", type: "core.load-map" },
			});
			const captured = host.snapshot().map;
			await rm(path.join(folder, "maps"), { force: true, recursive: true });

			const reopened = await openHost(folder);
			expect(reopened.snapshot().map).toEqual(captured);
		}));

	test("refuses to open a log whose map payload is known-invalid", async () =>
		await withHost(async (host, folder) => {
			await writeMap(folder, "cavern", CAVERN);
			await host.submit({
				actor: "gm-key",
				command: { name: "cavern", type: "core.load-map" },
			});
			await writeFile(
				path.join(folder, "events.jsonl"),
				`${JSON.stringify({
					actor: "gm-key",
					payload: { gameId: "fake" },
					seq: 1,
					timestamp: "2026-01-01T00:00:00.000Z",
					type: "core.room-created",
				})}\n${JSON.stringify({
					actor: "gm-key",
					payload: { name: "Hall", rows: ["..", "."] },
					seq: 2,
					timestamp: "2026-01-01T00:00:01.000Z",
					type: "core.map-loaded",
				})}\n`
			);
			await expect(openHost(folder)).rejects.toThrow(
				"Log loads a map with an invalid payload at event 2."
			);
		}));
});
