/* oxlint-disable vitest/prefer-importing-vitest-globals, eslint/sort-keys -- dual-lane suite with sequential command assertions. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { markTrustedRoomCommand } from "@supervillain/core";
import type {
	Envelope,
	HostRegistry,
	RoomSubmission,
} from "@supervillain/core";

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

const DESKTOP = "a".repeat(64);
const LAPTOP = "b".repeat(64);
const GUEST = "guest:abc123def456";

const withFolder = async (
	run: (folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(path.join(tmpdir(), "supervillain-linking-"));
	try {
		await run(folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

const openRoom = (folder: string): Promise<RoomHost> =>
	RoomHost.open({
		actor: DESKTOP,
		campaignFolder: folder,
		gameId: "fake",
		registry,
	});

const submitGatewayLink = (
	host: RoomHost,
	actor: string,
	linked: string
): Promise<RoomSubmission> =>
	host.submit(
		markTrustedRoomCommand({
			actor,
			command: { linked, type: "core.link-actor" },
		})
	);

const readLog = async (folder: string): Promise<Envelope[]> => {
	const text = await readFile(path.join(folder, "events.jsonl"), "utf-8");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Envelope);
};

describe("core.link-actor", () => {
	test("appends a gateway-stamped linking event and unions the two actors", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			const linked = await submitGatewayLink(host, LAPTOP, DESKTOP);
			expect(linked).toMatchObject({
				accepted: true,
				envelopes: [
					{
						actor: LAPTOP,
						payload: { linked: DESKTOP },
						type: "core.actor-linked",
					},
				],
			});
			expect(host.actors()).toContain(LAPTOP);
		}));

	test("is idempotent — being told twice costs nothing", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await submitGatewayLink(host, LAPTOP, DESKTOP);
			const again = await submitGatewayLink(host, LAPTOP, DESKTOP);
			expect(again).toEqual({ accepted: true, envelopes: [] });
			const log = await readLog(folder);
			expect(
				log.filter((one) => one.type === "core.actor-linked")
			).toHaveLength(1);
		}));

	test("refuses a gateway-stamped linking event that names nobody", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			expect(await submitGatewayLink(host, LAPTOP, "   ")).toEqual({
				message: "A linking event names no actor.",
				rejected: true,
			});
		}));

	test("refuses a non-gateway-stamped linking command", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			expect(
				await host.submit({
					actor: LAPTOP,
					command: { linked: GUEST, type: "core.link-actor" },
				})
			).toEqual({
				message: "Only the gateway may link actors.",
				rejected: true,
			});
		}));

	test("a gateway-stamped link needs no seat", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			const linked = await submitGatewayLink(host, LAPTOP, GUEST);
			expect(linked).toMatchObject({ accepted: true });
		}));
});

describe("GM roaming", () => {
	test("a linked second key claims the seat it already holds", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await submitGatewayLink(host, LAPTOP, DESKTOP);
			const claim = await host.submit({
				actor: LAPTOP,
				command: { type: "core.claim-seat" },
			});
			// No new seat: the laptop key resolves to the identity that holds 'gm'.
			expect(claim).toEqual({ accepted: true, envelopes: [] });
			expect(host.snapshot().table.seats).toEqual([
				{ actor: DESKTOP, characterId: null, id: "gm" },
			]);
		}));

	test("the linked key wields the GM's authority", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await submitGatewayLink(host, LAPTOP, DESKTOP);
			expect(
				await host.submit({
					actor: LAPTOP,
					command: { type: "core.chat", text: "from the laptop" },
				})
			).toMatchObject({ accepted: true });
		}));
});

describe("guest adoption", () => {
	test("makes a historical guest line reachable without rewriting it", async () =>
		await withFolder(async (folder) => {
			const first = await openRoom(folder);
			await first.submit({
				actor: GUEST,
				command: { type: "core.claim-seat" },
			});
			await first.submit({
				actor: GUEST,
				command: { type: "core.chat", text: "hi" },
			});
			const before = await readLog(folder);

			// The adopting key links, then reopens the folder cold: replay must
			// derive the same union with the old lines untouched.
			await submitGatewayLink(first, LAPTOP, GUEST);
			const reopened = await openRoom(folder);
			const after = await readLog(folder);
			expect(after.slice(0, before.length)).toEqual(before);
			expect(
				await reopened.submit({
					actor: LAPTOP,
					command: { type: "core.chat", text: "same person" },
				})
			).toMatchObject({ accepted: true });
			expect(reopened.actors()).toContain(GUEST);
		}));
});

describe("linking two already-seated actors", () => {
	test("accepts the link and resolves to the first seat in log order", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await host.submit({
				actor: LAPTOP,
				command: { type: "core.claim-seat" },
			});
			// The graph is the gateway's truth, so the room takes the fact rather
			// than refusing it and disagreeing forever. The identity then holds two
			// seats, and lookups answer with the earlier one. See openQuestions —
			// what *should* happen here is undecided in the definition.
			expect(await submitGatewayLink(host, LAPTOP, DESKTOP)).toMatchObject({
				accepted: true,
			});
			expect(host.snapshot().table.seats.map((seat) => seat.id)).toEqual([
				"gm",
				"player-1",
			]);
		}));
});

describe("the actor roster", () => {
	test("names every actor the log mentions, linked ones included", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await host.submit({
				actor: GUEST,
				command: { type: "core.claim-seat" },
			});
			await submitGatewayLink(host, LAPTOP, GUEST);
			expect([...host.actors()].toSorted()).toEqual(
				[DESKTOP, GUEST, LAPTOP].toSorted()
			);
		}));
});

describe("replay", () => {
	test("refuses a linking event that names no actor", async () =>
		await withFolder(async (folder) => {
			const host = await openRoom(folder);
			await host.submit({
				actor: DESKTOP,
				command: { type: "core.chat", text: "one" },
			});
			const log = await readFile(path.join(folder, "events.jsonl"), "utf-8");
			await writeFile(
				path.join(folder, "events.jsonl"),
				`${log}${JSON.stringify({
					actor: LAPTOP,
					payload: {},
					seq: 4,
					timestamp: "2026-07-25T00:00:00.000Z",
					type: "core.actor-linked",
				})}\n`
			);
			await expect(openRoom(folder)).rejects.toThrow(/names no actor/u);
		}));
});
