import { describe, expect } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { plainText } from "@supervillain/domain";
import { Effect, Layer, Schema } from "effect";

import { CampaignContent } from "../../src/content/index.ts";
import { checkLog } from "../../src/host/check.ts";
import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { SAMPLE } from "./campaign.ts";
import { effect } from "./effect.ts";
import { unreachable } from "./setWorld.ts";
import { tempDir } from "./tempDir.ts";

const alice = "key:SHA256:aliceALICEaliceKEY";

const ARI_YAML = `name: Ari
level: 1
size: medium
ancestry: human
class: fighter
attributes: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 }
hp: 20
speed: 25
perception: 7
ac: 18
saves: { fort: 7, ref: 7, will: 5 }
skills: { athletics: 9, intimidation: 5 }
shield: { bonus: 2, hardness: 5, hp: 20, broken: 10 }
strikes:
  - name: Longsword
    bonus: 9
    damage: 1d8+4 slashing
    traits: versatile p
  - name: Dagger
    bonus: 9
    damage: 1d4+4 piercing
    traits: [agile, finesse]
`;

const GNASHER_YAML = `name: Bog Gnasher
level: 1
traits: [animal]
attributes: { str: 3, dex: 2, con: 2, int: -4, wis: 1, cha: -2 }
hp: 20
speed: 30
perception: 6
ac: 16
saves: { fort: 7, ref: 5, will: 4 }
skills: { athletics: 7 }
strikes:
  - name: Jaws
    bonus: 9
    damage: 1d10+3 piercing
weaknesses: { fire: 3 }
`;

const campaign = Effect.gen(function* () {
	const dir = yield* tempDir;

	yield* Effect.promise(async () => {
		await writeFile(path.join(dir, "campaign.yaml"), "rules: pf2e\n");
		await mkdir(path.join(dir, "heroes"));
		await mkdir(path.join(dir, "monsters"));
		await mkdir(path.join(dir, "maps"));
		await writeFile(path.join(dir, "heroes/ari.yaml"), ARI_YAML);
		await writeFile(path.join(dir, "monsters/gnasher.yaml"), GNASHER_YAML);
		await copyFile(
			path.join(SAMPLE, "maps/ford-road.txt"),
			path.join(dir, "maps/ford-road.txt")
		);
	});

	return dir;
});

const said = (reply: Reply): ReadonlyArray<string> | string => {
	if (reply.kind === "done") {
		return reply.lines.map(plainText);
	}

	return reply.kind === "empty" ? "" : reply.text;
};

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const atTable = <A, E, R>(dir: string, body: Effect.Effect<A, E, R>) =>
	using(tableServices(dir, { setWorld: unreachable }), body);

const Logged = Schema.fromJsonString(
	Schema.Struct({ type: Schema.String, payload: Schema.Json })
);

describe("a PF2e campaign", () => {
	effect(
		"loads its sheets from YAML, fights on a map, and opens again from its log",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaign;

				yield* atTable(
					dir,
					Effect.gen(function* () {
						expect((yield* CampaignContent).ruleset).toBe("pf2e");
						expect(said(yield* runLine("gm", "/pc ari"))).toEqual([
							"Ari joins the party: level 1 human fighter, 20 HP, AC 18, Speed 25 ft.",
						]);
						expect(said(yield* runLine("gm", "/add gnasher x2 elite"))).toEqual(
							["2 × elite Bog Gnasher come: level 2, 30 HP, AC 18."]
						);
						expect(said(yield* runLine("gm", "/map ford"))).toEqual([
							"The map is The Ford Road, 20 by 10 squares of 5 ft.",
						]);
						yield* runLine(alice, "/name Alice");
						expect(said(yield* runLine(alice, "/play ari"))).toEqual([
							"Alice plays Ari.",
						]);
						yield* runLine("gm", "/place ari b5");
						yield* runLine("gm", "/place gnasher-1 c5");
						yield* runLine("gm", "/place gnasher-2 j5");
						const started = said(yield* runLine("gm", "/start"));
						const state = yield* Effect.flatMap(TableRoom, (r) => r.state);

						const names = (state.pf.combat?.order ?? []).map((id) =>
							id === "ari" ? "Ari" : `Bog Gnasher ${id.slice(-1)}`
						);

						expect(started).toContain(
							`The encounter begins. Initiative: ${names.join(", ")}.`
						);
						const turn = state.pf.combat?.turn?.id;
						expect(turn).toBeDefined();

						if (turn !== "ari") {
							yield* runLine("gm", "/turn ari");
						}

						const strike = said(
							yield* runLine(alice, "/strike ari long gnasher-1")
						);

						expect(strike.at(0)).toStartWith(
							"Ari Strikes Bog Gnasher 1 with Longsword:"
						);
						expect(said(yield* runLine(alice, "/stride ari a6"))).toEqual([
							"Ari Strides to a6 (5 ft).",
						]);
						expect(said(yield* runLine(alice, "/sheet ari"))).toContain(
							"AC 18; Fort +7, Ref +7, Will +5"
						);
						expect(
							said(yield* runLine(alice, "/strike ari long gnasher-2"))
						).toBe(
							"Bog Gnasher 2 is 45 ft away; Ari's Longsword reaches 5 ft."
						);
						expect(said(yield* runLine("gm", "/hero ari"))).toStartWith(
							"Unknown command /hero."
						);
					})
				);

				const log = yield* Effect.promise(
					async () => await readFile(path.join(dir, "events.jsonl"), "utf-8")
				);

				expect(
					yield* Schema.decodeEffect(Logged)(log.split("\n")[0] ?? "")
				).toMatchObject({
					type: "pf.pc-joined",
					payload: {
						sheet: {
							id: "ari",
							hp: 20,
							strikes: [{ name: "Longsword" }, { name: "Dagger" }],
						},
					},
				});

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const state = yield* Effect.flatMap(TableRoom, (r) => r.state);
						const ari = state.pf.creatures.find((c) => c.id === "ari");

						expect(ari?.at).toEqual({ x: 0, y: 5 });
						expect(ari?.player).toBe(alice);
						expect(state.pf.combat?.turn).toMatchObject({
							id: "ari",
							actions: 1,
							attacks: 1,
						});
						expect(
							state.pf.creatures.filter((c) => c.adjustment === "elite")
						).toHaveLength(2);
					})
				);

				const report = checkLog(path.join(dir, "events.jsonl"), log, "pf2e");

				expect(report.error).toBeUndefined();
				expect(report.warnings).toEqual([]);
				expect(report.out.join("\n")).toContain("pf.struck ×1");
				expect(report.out.join("\n")).toContain("Ari Strides to a6 (5 ft).");
			})
	);

	effect(
		"a sheet that doesn't load is refused, naming the file and field",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaign;

				yield* Effect.promise(async () => {
					await writeFile(
						path.join(dir, "heroes/broken.yaml"),
						ARI_YAML.replace("hp: 20", "hp: lots").replace(
							"damage: 1d8+4 slashing",
							"damage: plenty slashing"
						)
					);
				});

				yield* atTable(
					dir,
					Effect.gen(function* () {
						const reply = yield* runLine("gm", "/pc broken");

						expect(reply.kind).toBe("refusal");
						expect(said(reply)).toContain(
							"heroes/broken.yaml: hp must be a whole number, 1 or more"
						);
					})
				);
			})
	);
});
