/* oxlint-disable vitest/prefer-importing-vitest-globals, unicorn/no-await-expression-member -- dual-lane suite with sequential command assertions. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HostRegistry, RoomSubmission } from "@supervillain/core";

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

const withMappedHost = async (
	run: (host: RoomHost, folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-token-"));
	try {
		await mkdir(path.join(folder, "maps"), { recursive: true });
		await writeFile(path.join(folder, "maps", "cavern.map"), CAVERN);
		const host = await RoomHost.open({
			actor: "gm-key",
			campaignFolder: folder,
			gameId: "fake",
			registry,
		});
		await host.submit({
			actor: "gm-key",
			command: { name: "cavern", type: "core.load-map" },
		});
		await run(host, folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

const seatPlayer = async (host: RoomHost, actor: string): Promise<string> => {
	await host.submit({ actor, command: { type: "core.claim-seat" } });
	return (
		host.snapshot().table.seats.find((seat) => seat.actor === actor)?.id ?? ""
	);
};

const place = async (
	host: RoomHost,
	actor: string,
	extra: Record<string, unknown>
): Promise<RoomSubmission> =>
	await host.submit({
		actor,
		command: { glyph: "@", type: "core.place-token", x: 1, y: 1, ...extra },
	});

describe("RoomHost battle-map tokens", () => {
	test("the GM places a token and the host mints its id", async () =>
		await withMappedHost(async (host) => {
			const placed = await place(host, "gm-key", { label: "Kraan" });
			expect(placed).toMatchObject({
				accepted: true,
				envelopes: [
					{
						actor: "gm-key",
						payload: {
							glyph: "@",
							id: "token-1",
							label: "Kraan",
							seatId: null,
							x: 1,
							y: 1,
						},
						type: "core.token-placed",
					},
				],
			});
			expect(host.snapshot().tokens).toEqual([
				{ glyph: "@", id: "token-1", label: "Kraan", seatId: null, x: 1, y: 1 },
			]);
		}));

	test("placing onto an id already on the surface re-glyphs it", async () =>
		await withMappedHost(async (host) => {
			await place(host, "gm-key", { label: "Kraan" });
			const reglyphed = await place(host, "gm-key", {
				glyph: "K",
				id: "token-1",
				label: "Kraan",
			});
			expect(reglyphed).toMatchObject({ accepted: true });
			expect(host.snapshot().tokens).toEqual([
				{ glyph: "K", id: "token-1", label: "Kraan", seatId: null, x: 1, y: 1 },
			]);
		}));

	test("the GM moves and removes any token", async () =>
		await withMappedHost(async (host) => {
			await place(host, "gm-key", { label: "Kraan" });
			expect(
				await host.submit({
					actor: "gm-key",
					command: { id: "token-1", type: "core.move-token", x: 3, y: 2 },
				})
			).toMatchObject({ accepted: true });
			expect(host.snapshot().tokens[0]).toMatchObject({ x: 3, y: 2 });
			expect(
				await host.submit({
					actor: "gm-key",
					command: { id: "token-1", type: "core.remove-token" },
				})
			).toMatchObject({ accepted: true });
			expect(host.snapshot().tokens).toEqual([]);
		}));

	test("a player moves a token bound to their own seat", async () =>
		await withMappedHost(async (host) => {
			const seatId = await seatPlayer(host, "player-key");
			await place(host, "gm-key", { label: "Vex", seatId });
			expect(
				await host.submit({
					actor: "player-key",
					command: { id: "token-1", type: "core.move-token", x: 2, y: 1 },
				})
			).toMatchObject({ accepted: true });
			expect(host.snapshot().tokens[0]).toMatchObject({ x: 2, y: 1 });
		}));

	test("a player cannot move anyone else's token", async () =>
		await withMappedHost(async (host) => {
			const seatId = await seatPlayer(host, "player-key");
			await seatPlayer(host, "other-key");
			await place(host, "gm-key", { label: "Vex", seatId });
			expect(
				await host.submit({
					actor: "other-key",
					command: { id: "token-1", type: "core.move-token", x: 2, y: 1 },
				})
			).toEqual({
				message: "Token 'token-1' is not bound to your seat.",
				rejected: true,
			});
			expect(host.snapshot().tokens[0]).toMatchObject({ x: 1, y: 1 });
		}));

	test("a player cannot move an unbound token", async () =>
		await withMappedHost(async (host) => {
			await seatPlayer(host, "player-key");
			await place(host, "gm-key", { label: "Kraan" });
			expect(
				await host.submit({
					actor: "player-key",
					command: { id: "token-1", type: "core.move-token", x: 2, y: 1 },
				})
			).toMatchObject({ rejected: true });
		}));

	test("a player can never place or remove", async () =>
		await withMappedHost(async (host) => {
			const seatId = await seatPlayer(host, "player-key");
			await place(host, "gm-key", { label: "Vex", seatId });
			expect(await place(host, "player-key", { label: "Sneak" })).toEqual({
				message: "Only the GM can place or remove tokens.",
				rejected: true,
			});
			expect(
				await host.submit({
					actor: "player-key",
					command: { id: "token-1", type: "core.remove-token" },
				})
			).toEqual({
				message: "Only the GM can place or remove tokens.",
				rejected: true,
			});
		}));

	test("refuses positions off the grid and glyphs that are not one character", async () =>
		await withMappedHost(async (host) => {
			expect(await place(host, "gm-key", { x: 9, y: 0 })).toMatchObject({
				rejected: true,
			});
			expect(await place(host, "gm-key", { glyph: "@@" })).toEqual({
				message: "A token glyph is exactly one printable character.",
				rejected: true,
			});
			expect(host.snapshot().tokens).toEqual([]);
		}));

	test("refuses a seat binding no seat at the table answers to", async () =>
		await withMappedHost(async (host) => {
			expect(await place(host, "gm-key", { seatId: "player-9" })).toMatchObject(
				{ rejected: true }
			);
		}));

	test("clearing or reloading the map empties the surface", async () =>
		await withMappedHost(async (host) => {
			await place(host, "gm-key", { label: "Kraan" });
			await host.submit({
				actor: "gm-key",
				command: { name: "cavern", type: "core.load-map" },
			});
			expect(host.snapshot().tokens).toEqual([]);
			await place(host, "gm-key", { label: "Kraan" });
			await host.submit({
				actor: "gm-key",
				command: { type: "core.clear-map" },
			});
			expect(host.snapshot().tokens).toEqual([]);
		}));

	test("refuses tokens when no map is loaded", async () =>
		await withMappedHost(async (host) => {
			await host.submit({
				actor: "gm-key",
				command: { type: "core.clear-map" },
			});
			expect(await place(host, "gm-key", {})).toEqual({
				message: "No battle map is loaded.",
				rejected: true,
			});
		}));

	test("replays the token surface byte-identically from the log", async () =>
		await withMappedHost(async (host, folder) => {
			await place(host, "gm-key", { label: "Kraan" });
			await place(host, "gm-key", { glyph: "g", label: "Goblin", x: 2, y: 2 });
			await host.submit({
				actor: "gm-key",
				command: { id: "token-1", type: "core.move-token", x: 3, y: 1 },
			});
			const before = host.snapshot().tokens;
			const reopened = await RoomHost.open({
				campaignFolder: folder,
				registry,
			});
			expect(reopened.snapshot().tokens).toEqual(before);
			// The counter is log-derived, so the next mint is the same either way.
			expect(
				await place(reopened, "gm-key", { label: "Third", x: 3, y: 2 })
			).toMatchObject({ envelopes: [{ payload: { id: "token-3" } }] });
		}));
});
