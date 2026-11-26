import { describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Ref, Schema, Stream } from "effect";

import {
	changedCards,
	ContentWatch,
	staleOf,
	watched,
} from "../../src/host/ContentWatch.ts";
import { runLine } from "../../src/host/line.ts";
import { openSeat } from "../../src/host/Seat.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { campaignOf, FULL, MARKET } from "../content/files.ts";
import { DOOR_OPEN_LINE, openSampleCampaign } from "./campaign.ts";
import { effect, must } from "./effect.ts";
import type { Platform } from "./effect.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const WATCH_UP = "300 millis";

const QUIET = "900 millis";

const atTable = <A, E>(
	dir: string,
	body: Effect.Effect<A, E, TableServices | Platform>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(tableServices(dir)), (context) =>
			Effect.provideContext(
				Effect.andThen(Effect.sleep(WATCH_UP), body),
				context
			)
		)
	);

const freeform = campaignOf({
	...FULL,
	"events.jsonl": `${DOOR_OPEN_LINE}\n`,
});

const until = <A, R>(
	what: string,
	read: Effect.Effect<A, never, R>,
	ok: (value: A) => boolean,
	deadline = performance.now() + 5000
): Effect.Effect<A, never, R> =>
	Effect.gen(function* () {
		const value = yield* read;

		if (ok(value)) {
			return value;
		}

		if (performance.now() > deadline) {
			return yield* Effect.die(new Error(`timed out waiting for ${what}`));
		}

		yield* Effect.sleep("25 millis");

		return yield* until(what, read, ok, deadline);
	});

const write = (dir: string, file: string, text: string) =>
	Effect.promise(async () => {
		await writeFile(path.join(dir, file), text);
	});

const marketBody = Effect.gen(function* () {
	const room = yield* TableRoom;
	const state = yield* room.state;

	return json(state.stage.cards["scene:market"]?.card.body ?? []);
});

describe("which files the watcher reads again", () => {
	test("content folders, table.md and campaign.yaml; never the log, keys, schemas or editor litter", () => {
		for (const file of [
			"table.md",
			"campaign.yaml",
			"scenes/market.md",
			"npcs/mara.md",
			"handouts/ledger.md",
			"items/brass-key.md",
			"abilities/judgment.md",
			"party/rook.md",
			"heroes/brann.yaml",
			"monsters/thug.md",
			"maps/market.txt",
			"art/mara.txt",
		]) {
			expect([file, watched(file)]).toEqual([file, true]);
		}

		for (const file of [
			"events.jsonl",
			"events.lock",
			"host.log",
			"host_key",
			"relay_known",
			"README.md",
			"schemas/scene.schema.json",
			".git/index",
			"scenes/.market.md.swp",
			"scenes/market.md~",
			"scenes/4913",
			"scenes/.hidden/market.md",
			"",
		]) {
			expect([file, watched(file)]).toEqual([file, false]);
		}
	});

	test("a card differs when any of its shown parts do; a sheet when it does", () => {
		const card = {
			key: "npc:mara",
			kind: "npc" as const,
			title: "Mara",
			body: [{ kind: "para" as const, text: "Hi." }],
		};

		const state = {
			stage: {
				cards: { "npc:mara": { card, tier: "revealed" as const, since: 1 } },
				trackers: [],
				recap: [],
			},
		};

		expect(changedCards(state, [card])).toEqual([]);
		expect(
			changedCards(state, [{ ...card, title: "Mara Venn" }]).map((c) => c.title)
		).toEqual(["Mara Venn"]);
		expect(changedCards(state, [{ ...card, key: "npc:ghost" }])).toEqual([]);

		const fresh = new Map<string, unknown>([
			["brann", { stamina: 24 }],
			["kesh", { stamina: 21 }],
		]);

		expect(
			staleOf(
				[
					{ id: "brann", sheet: { stamina: 20 } },
					{ id: "kesh", sheet: { stamina: 21 } },
					{ id: "wren", sheet: { stamina: 1 } },
				],
				fresh
			)
		).toEqual(["brann"]);
	});
});

describe("the content watcher at a hosted table", () => {
	effect(
		"an edit to a card on the stage reaches the table by itself",
		() =>
			Effect.gen(function* () {
				const dir = yield* freeform;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;
						const room = yield* TableRoom;

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						expect(yield* marketBody).toContain("Stalls lean over the water.");

						yield* write(
							dir,
							"scenes/market.md",
							MARKET.replace("Stalls lean", "Stalls sink")
						);

						yield* until("the synced card", marketBody, (body) =>
							body.includes("Stalls sink over the water.")
						);

						const index = yield* watch.index.get;

						expect(
							json(must(index.scenes[0], "the market").sections)
						).toContain("Stalls sink");
						expect((yield* room.state).feed.at(-1)?.text).toBe(
							"Scene: The Drowned Market is read again."
						);
						expect(yield* marketBody).not.toContain("GMSECRET");
						expect(yield* watch.problems.get).toEqual([]);
					})
				);
			}),
		15_000
	);

	effect(
		"GM notes turning into player text mid-edit are held back until the GM syncs them",
		() =>
			Effect.gen(function* () {
				const dir = yield* freeform;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;
						const room = yield* TableRoom;

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						yield* write(
							dir,
							"scenes/market.md",
							MARKET.replace("## GM Notes", "## G")
						);

						yield* until("the held card", watch.held.get, (keys) =>
							keys.includes("scene:market")
						);

						expect(yield* marketBody).not.toContain("GMSECRET");
						expect((yield* room.state).feed.at(-1)?.text).not.toContain(
							"read again"
						);

						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						expect(gm.prep?.sync?.()).toEqual({
							kind: "send",
							label: "Sync The Drowned Market",
							line: "/sync scene:market",
							lines: ["/sync scene:market"],
						});

						expect((yield* runLine("gm", "/sync scene:market")).kind).toBe(
							"done"
						);
						yield* until(
							"the hold to clear",
							watch.held.get,
							(keys) => keys.length === 0
						);
						expect(yield* marketBody).toContain("GMSECRET");
					})
				);
			}),
		15_000
	);

	effect(
		"an ordinary edit after a held one still syncs by itself, without the held card",
		() =>
			Effect.gen(function* () {
				const dir = yield* freeform;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						expect((yield* runLine("gm", "/show mara")).kind).toBe("done");
						yield* write(
							dir,
							"scenes/market.md",
							MARKET.replace("## GM Notes", "## G")
						);
						yield* until("the held card", watch.held.get, (keys) =>
							keys.includes("scene:market")
						);
						yield* write(
							dir,
							"npcs/mara.md",
							FULL["npcs/mara.md"].replace("weathered", "wary")
						);

						const room = yield* TableRoom;

						yield* until(
							"mara read again",
							Effect.map(room.state, (state) =>
								json(state.stage.cards["npc:mara"]?.card.body ?? [])
							),
							(body) => body.includes("wary")
						);

						expect(yield* marketBody).not.toContain("GMSECRET");
						expect(yield* watch.held.get).toEqual(["scene:market"]);
					})
				);
			}),
		15_000
	);

	effect(
		"sync: manual leaves the stage alone until /sync",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"table.md": FULL["table.md"].replace(
						"start: market\n",
						"start: market\nsync: manual\n"
					),
					"events.jsonl": `${DOOR_OPEN_LINE}\n`,
				});

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						yield* write(
							dir,
							"scenes/market.md",
							MARKET.replace("Stalls lean", "Stalls sink")
						);
						yield* until("the fresh index", watch.index.get, (index) =>
							json(index.scenes).includes("Stalls sink")
						);

						expect(yield* marketBody).toContain("Stalls lean");
						expect((yield* runLine("gm", "/sync")).kind).toBe("done");
						expect(yield* marketBody).toContain("Stalls sink");
					})
				);
			}),
		15_000
	);

	effect(
		"a broken edit keeps the last good files, says what's wrong, and play goes on",
		() =>
			Effect.gen(function* () {
				const dir = yield* freeform;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						yield* write(
							dir,
							"scenes/market.md",
							MARKET.replace("summary:", "weather: rain\nsummary:").replace(
								"Stalls lean",
								"Stalls sink"
							)
						);

						const problems = yield* until(
							"the problem",
							watch.problems.get,
							(found) => found.length > 0
						);

						expect(problems).toEqual([
							"scenes/market.md: weather is not a field supervillain knows (check the spelling)",
							"table.md: start names market, but there's no scenes/market.md",
						]);

						const index = yield* watch.index.get;

						expect(json(index.scenes)).not.toContain("Stalls sink");
						expect(yield* marketBody).toContain("Stalls lean");
						expect((yield* runLine("gm", "/recap Still playing.")).kind).toBe(
							"done"
						);

						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						expect(gm.contentProblems?.()).toEqual(problems);

						yield* write(dir, "scenes/market.md", MARKET);
						yield* until(
							"the problem to clear",
							watch.problems.get,
							(found) => found.length === 0
						);
					})
				);
			}),
		15_000
	);

	effect(
		"the log, the host's own files and editor litter never wake it",
		() =>
			Effect.gen(function* () {
				const dir = yield* freeform;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;
						const wakes = yield* Ref.make(0);

						yield* watch.index.changes.pipe(
							Stream.drop(1),
							Stream.runForEach(() => Ref.update(wakes, (n) => n + 1)),
							Effect.forkScoped
						);

						expect((yield* runLine("gm", "/show market")).kind).toBe("done");
						expect((yield* runLine("gm", "/recap One.")).kind).toBe("done");
						expect((yield* runLine("gm", "/recap Two.")).kind).toBe("done");

						yield* Effect.promise(async () => {
							await appendFile(path.join(dir, "host.log"), "a line\n");
							await writeFile(path.join(dir, "notes.txt"), "mine\n");
							await writeFile(path.join(dir, "scenes/.market.md.swp"), "x");
							await writeFile(path.join(dir, "scenes/market.md~"), "x");
							await writeFile(path.join(dir, "scenes/4913"), "x");
						});
						yield* Effect.sleep(QUIET);

						expect(yield* Ref.get(wakes)).toBe(0);

						const log = yield* Effect.promise(
							async () =>
								await readFile(path.join(dir, "events.jsonl"), "utf-8")
						);

						expect(log).not.toContain("core.content-synced");

						yield* write(
							dir,
							"npcs/mara.md",
							FULL["npcs/mara.md"].replace("ledger", "lantern")
						);
						yield* until("a wake", Ref.get(wakes), (n) => n > 0);
					})
				);
			}),
		15_000
	);

	effect(
		"a hero whose sheet changed on disk is stale, and the prep panel syncs it",
		() =>
			Effect.gen(function* () {
				const dir = yield* openSampleCampaign;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const watch = yield* ContentWatch;

						expect((yield* runLine("gm", "/hero brann")).kind).toBe("done");
						yield* Effect.sleep("100 millis");

						expect(yield* watch.stale.get).toEqual([]);

						const sheet = path.join(dir, "heroes/brann.yaml");

						yield* Effect.promise(async () => {
							const text = await readFile(sheet, "utf-8");
							await writeFile(
								sheet,
								text.replace("stamina: 24", "stamina: 30")
							);
						});
						yield* until("brann to go stale", watch.stale.get, (ids) =>
							ids.includes("brann")
						);

						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						yield* until(
							"the sync row",
							Effect.sync(() => gm.prep?.sync?.()),
							(item) => item !== undefined
						);

						expect(gm.prep?.sync?.()).toEqual({
							kind: "send",
							label: "Sync Brann",
							line: "/hero brann",
							lines: ["/hero brann"],
						});

						expect((yield* runLine("gm", "/hero brann")).kind).toBe("done");
						yield* until(
							"brann to be fresh",
							watch.stale.get,
							(ids) => ids.length === 0
						);
					})
				);
			}),
		15_000
	);
});
