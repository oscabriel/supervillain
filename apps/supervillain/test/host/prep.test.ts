import { describe, expect } from "bun:test";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { plainText, readMapText } from "@supervillain/domain";
import { Effect, Layer, Random, Schema } from "effect";

import { generateMap, mapFileText } from "../../src/content/mapgen.ts";
import { writeGeneratedMap } from "../../src/content/newMap.ts";
import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { openSeat } from "../../src/host/Seat.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { PrepItem, TableView } from "../../src/table/view.ts";
import { openSampleCampaign, sampleCampaign } from "./campaign.ts";
import { effect, must, waitFor } from "./effect.ts";
import type { Platform } from "./effect.ts";
import { unreachable } from "./setWorld.ts";

const alice = "key:SHA256:aliceAAAAkeyfingerprint";

const noSetWorld = unreachable;

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const atTable = <A, E>(
	dir: string,
	body: Effect.Effect<A, E, TableServices | Platform>
) => using(tableServices(dir, { setWorld: noSetWorld }), body);

const said = (reply: Reply): ReadonlyArray<string> | string => {
	if (reply.kind === "done") {
		return reply.lines.map(plainText);
	}

	return reply.kind === "empty" ? "" : reply.text;
};

const Logged = Schema.fromJsonString(
	Schema.Struct({ type: Schema.String, payload: Schema.Json })
);

const CROSSING_ID = /^crossing-\d+$/u;

const MAP_SAID = /^The map is .+, 24 by 14\.$/u;

const NAMED_BRANN = /^name: Brann$/mu;

const stateNow = Effect.flatMap(TableRoom, (r) => r.state);

const noted = (note: string | undefined) =>
	note === undefined || note === "" ? "" : ` (${note})`;

const items = (list: ReadonlyArray<PrepItem>) =>
	list.map((i) => `${i.label} ${i.line}${noted(i.note)}`);

type PrepView = NonNullable<ReturnType<NonNullable<TableView["prep"]>["view"]>>;

const listing = (v: PrepView) => {
	const loaded =
		v.maps.loaded === undefined ? [] : [`${v.maps.loaded.name} (loaded)`];

	return [
		...v.sections.map((s) => [s.title, items(s.items)]),
		["maps", [...loaded, ...items(v.maps.items)]],
		["place", v.place.map((t) => `${t.name} /place ${t.id}`)],
		["start", "line" in v.start ? v.start.line : v.start.note],
	];
};

const listed = (view: TableView) => {
	const v = view.prep?.view();

	return v === undefined ? undefined : listing(v);
};

const listedNow = (view: TableView) =>
	must(listed(view), "the GM's prep panel is open");

const reload = (view: TableView) =>
	Effect.promise(
		async () => await must(view.prep, "the GM has a prep panel").reload()
	);

const mapFiles = (dir: string) =>
	Effect.promise(async () => {
		const names = await readdir(path.join(dir, "maps"));

		return names.toSorted();
	});

describe("the prep panel's lists, from the campaign", () => {
	effect(
		"the GM's seat lists the sample's files with their names; a player's seat has none",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* atTable(
					dir,
					Effect.gen(function* () {
						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						const player = yield* openSeat({
							actor: alice,
							room: "den",
							leave: () => {},
						});

						expect(player.prep).toBeUndefined();
						expect(gm.prep?.view()).toBeUndefined();
						expect(yield* reload(gm)).toBeUndefined();
						expect(listed(gm)).toEqual([
							[
								"heroes",
								[
									"Brann /hero brann",
									"Ilsa /hero ilsa",
									"Kesh /hero kesh",
									"Wren /hero wren",
								],
							],
							[
								"monsters",
								[
									"Bandit Bruiser /add bandit-bruiser",
									"Bandit Chief /add bandit-chief",
									"Bandit Cutpurse /add bandit-cutpurse",
									"Bandit Slinger /add bandit-slinger",
								],
							],
							[
								"maps",
								[
									"The Ford Road /map ford-road",
									"New crossing /map new crossing",
									"New keep /map new keep",
									"New, by seed /map new ",
								],
							],
							["place", []],
							["start", "/start"],
						]);
						yield* runLine("gm", "/hero brann");
						yield* runLine("gm", "/map ford");
						yield* runLine("gm", "/add bandit-chief");
						yield* waitFor("the panel to follow the table", () =>
							JSON.stringify(listed(gm)).includes(
								"Bandit Chief /add bandit-chief (×1)"
							)
						);
						const now = listedNow(gm);
						expect(now[0]).toEqual([
							"heroes",
							["Ilsa /hero ilsa", "Kesh /hero kesh", "Wren /hero wren"],
						]);
						expect(now[1]?.[1]).toContain(
							"Bandit Chief /add bandit-chief (×1)"
						);
						expect(now[2]?.[1]).toEqual([
							"The Ford Road (loaded)",
							"Put away /map off",
							"New crossing /map new crossing",
							"New keep /map new keep",
							"New, by seed /map new ",
						]);
						expect(now[3]).toEqual([
							"place",
							["Brann /place brann", "Bandit Chief /place bandit-chief"],
						]);
					})
				);
			})
	);

	effect(
		"files are read again each time the panel opens: a new sheet shows, a broken one by its id",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* atTable(
					dir,
					Effect.gen(function* () {
						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						yield* reload(gm);
						yield* Effect.promise(async () => {
							const brann = await readFile(
								path.join(dir, "heroes/brann.yaml"),
								"utf-8"
							);

							await writeFile(
								path.join(dir, "heroes/tor.yaml"),
								brann.replace(NAMED_BRANN, "name: Tor")
							);
							await writeFile(
								path.join(dir, "heroes/broken.yaml"),
								"name: [unclosed\n"
							);
						});
						expect(listedNow(gm)[0]?.[1]).not.toContain("Tor /hero tor");
						yield* reload(gm);
						expect(listedNow(gm)[0]?.[1]).toEqual([
							"Brann /hero brann",
							"broken /hero broken",
							"Ilsa /hero ilsa",
							"Kesh /hero kesh",
							"Tor /hero tor",
							"Wren /hero wren",
						]);
					})
				);
			})
	);

	effect(
		"a set.world campaign: Recruit and Foe, maps, who to place, Start",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* Effect.promise(async () => {
					await writeFile(
						path.join(dir, "campaign.yaml"),
						"rules: set-world\n"
					);
				});
				yield* atTable(
					dir,
					Effect.gen(function* () {
						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						yield* reload(gm);
						expect(listed(gm)).toEqual([
							["fighters", ["Recruit /recruit ", "Foe /foe "]],
							[
								"maps",
								[
									"The Ford Road /map ford-road",
									"New crossing /map new crossing",
									"New keep /map new keep",
									"New, by seed /map new ",
								],
							],
							["place", []],
							["start", "/start"],
						]);
					})
				);
			})
	);
});

describe("/map new: a generated map, written into maps/ and loaded", () => {
	effect(
		"by its seed: the file is the CLI's, the event carries the grid, replay reads no file",
		() =>
			Effect.gen(function* () {
				const dir = yield* openSampleCampaign;
				const text = mapFileText(generateMap("keep", 42));
				const grid = readMapText("keep-42", text);

				if ("refusal" in grid) {
					throw new Error(grid.refusal);
				}

				yield* atTable(
					dir,
					Effect.gen(function* () {
						expect(said(yield* runLine("gm", "/map new keep 42"))).toEqual([
							`The map is ${grid.name}, 24 by 14.`,
						]);
						const { map } = (yield* stateNow).ds;
						expect(map).toMatchObject({
							id: "keep-42",
							name: grid.name,
							terrain: grid.terrain,
						});
						expect(map?.dressing).toEqual(grid.dressing);
						expect(said(yield* runLine("gm", "/map new keep 42"))).toBe(
							"There's already a map called keep-42 in maps/: /map keep-42 loads it."
						);
						expect(said(yield* runLine(alice, "/map new crossing 9"))).toBe(
							"Only the GM can use /map."
						);
					})
				);
				expect(yield* mapFiles(dir)).toEqual(["ford-road.txt", "keep-42.txt"]);
				expect(
					yield* Effect.promise(
						async () =>
							await readFile(path.join(dir, "maps/keep-42.txt"), "utf-8")
					)
				).toBe(text);

				const log = yield* Effect.promise(
					async () => await readFile(path.join(dir, "events.jsonl"), "utf-8")
				);

				expect(
					yield* Schema.decodeEffect(Logged)(
						log.trim().split("\n").at(-1) ?? ""
					)
				).toMatchObject({
					type: "ds.map-loaded",
					payload: { id: "keep-42", terrain: grid.terrain },
				});
				yield* Effect.promise(async () => {
					await Promise.all(
						["maps", "scenes", "handouts", "table.md"].map(async (folder) => {
							await rm(path.join(dir, folder), { recursive: true });
						})
					);
				});
				yield* atTable(
					dir,
					Effect.gen(function* () {
						expect((yield* stateNow).ds.map).toMatchObject({
							id: "keep-42",
							terrain: grid.terrain,
						});
					})
				);
			})
	);

	effect("without a seed the host picks one, and the map's id says which", () =>
		Effect.gen(function* () {
			const dir = yield* sampleCampaign;
			yield* atTable(
				dir,
				Effect.gen(function* () {
					const reply = yield* runLine("gm", "/map new crossing").pipe(
						Random.withSeed("supervillain")
					);

					expect(reply.kind).toBe("done");
					const id = (yield* stateNow).ds.map?.id ?? "";
					expect(id).toMatch(CROSSING_ID);
					const seed = Number(id.slice("crossing-".length));

					const grid = readMapText(
						id,
						mapFileText(generateMap("crossing", seed))
					);

					expect((yield* stateNow).ds.map?.terrain).toEqual(
						"refusal" in grid ? [] : grid.terrain
					);
				})
			);
			expect(
				(yield* mapFiles(dir)).filter((f) => f.startsWith("crossing-"))
			).toHaveLength(1);
		})
	);

	effect("a set.world table generates its map the same way", () =>
		Effect.gen(function* () {
			const dir = yield* sampleCampaign;
			yield* Effect.promise(async () => {
				await writeFile(path.join(dir, "campaign.yaml"), "rules: set-world\n");
			});
			yield* atTable(
				dir,
				Effect.gen(function* () {
					expect(said(yield* runLine("gm", "/map new crossing 7"))).toEqual([
						expect.stringMatching(MAP_SAID),
					]);
					expect((yield* stateNow).sw.map?.id).toBe("crossing-7");
				})
			);
			expect(yield* mapFiles(dir)).toContain("crossing-7.txt");
		})
	);

	effect(
		"a file that would load by the same id, in other letters, is never written beside",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* Effect.promise(async () => {
					await copyFile(
						path.join(dir, "maps/ford-road.txt"),
						path.join(dir, "maps/Keep-42.txt")
					);
				});
				yield* atTable(
					dir,
					Effect.gen(function* () {
						expect(said(yield* runLine("gm", "/map new keep 42"))).toBe(
							"There's already a map called keep-42 in maps/: /map keep-42 loads it."
						);
						expect((yield* stateNow).ds.map).toBeUndefined();
					})
				);
				expect(yield* mapFiles(dir)).toEqual(["Keep-42.txt", "ford-road.txt"]);
			})
	);

	effect(
		"the writer takes no seed /map new wouldn't, and no id /map reads as a word",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;

				for (const seed of [-1, 4_294_967_296, 1.5]) {
					expect(
						(yield* Effect.flip(writeGeneratedMap(dir, "keep", seed))).reason
					).toBe("bad-seed");
				}

				for (const id of ["new", "OFF"]) {
					expect(
						(yield* Effect.flip(writeGeneratedMap(dir, "keep", 1, id))).reason
					).toBe("bad-id");
				}

				expect(yield* mapFiles(dir)).toEqual(["ford-road.txt"]);
			})
	);

	effect(
		"the GM's panel lists the maps /map new wrote, without being reopened",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* atTable(
					dir,
					Effect.gen(function* () {
						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						yield* reload(gm);
						yield* runLine("gm", "/map new keep 42");
						yield* waitFor(
							"the panel to load it",
							() => gm.prep?.view()?.maps.loaded?.again === "/map new keep"
						);
						yield* runLine("gm", "/map new keep 43");
						yield* waitFor("the panel to read maps/ again", () =>
							JSON.stringify(listed(gm)).includes("/map keep-42")
						);
					})
				);
			})
	);
});

describe("the prep panel's maps", () => {
	effect(
		"not one /map reads as a word, nor one too big to load, which is listed unread",
		() =>
			Effect.gen(function* () {
				const dir = yield* sampleCampaign;
				yield* Effect.promise(async () => {
					const ford = await readFile(path.join(dir, "maps/ford-road.txt"));
					await writeFile(path.join(dir, "maps/new.txt"), ford);
					await writeFile(path.join(dir, "maps/off.txt"), ford);
					await writeFile(
						path.join(dir, "maps/huge.txt"),
						`name: Huge\n${".".repeat(64 * 1024)}\n`
					);
				});
				yield* atTable(
					dir,
					Effect.gen(function* () {
						const gm = yield* openSeat({
							actor: "gm",
							room: "den",
							leave: () => {},
						});

						yield* reload(gm);
						expect(listedNow(gm)[2]).toEqual([
							"maps",
							[
								"The Ford Road /map ford-road",
								"huge /map huge",
								"New crossing /map new crossing",
								"New keep /map new keep",
								"New, by seed /map new ",
							],
						]);
					})
				);
			})
	);
});
