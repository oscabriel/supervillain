import { describe, expect } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TableState } from "@supervillain/domain";
import { Effect, Layer, Schema } from "effect";

import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import { recordedAnswer } from "../setWorld/harness.ts";
import { SAMPLE } from "./campaign.ts";
import { effect } from "./effect.ts";
import type { Platform } from "./effect.ts";
import { answering } from "./setWorld.ts";
import { tempDir } from "./tempDir.ts";

const alice = "key:SHA256:aliceALICEaliceKEY";

const Logged = Schema.Struct({ actor: Schema.String, type: Schema.String });

const decodeLogged = Schema.decodeUnknownSync(Schema.fromJsonString(Logged));

const campaign = (rules: string | undefined) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		yield* Effect.promise(async () => {
			if (rules !== undefined) {
				await writeFile(path.join(dir, "campaign.yaml"), rules);
			}

			await mkdir(path.join(dir, "maps"));
			await copyFile(
				path.join(SAMPLE, "maps/ford-road.txt"),
				path.join(dir, "maps/ford-road.txt")
			);
		});

		return dir;
	});

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
) =>
	using(
		tableServices(dir, {
			setWorld: answering(recordedAnswer),
			autoFoes: { pause: "1 millis" },
		}),
		body
	);

const state = Effect.flatMap(TableRoom, (room) => room.state);

const turnOf = (s: TableState) => s.sw.fight?.turn?.id;

const until = (what: string, holds: (s: TableState) => boolean) =>
	Effect.gen(function* () {
		for (let tries = 0; tries < 400; tries += 1) {
			const now = yield* state;

			if (holds(now)) {
				return now;
			}

			yield* Effect.sleep("5 millis");
		}

		return yield* Effect.die(new Error(`never came: ${what}`));
	});

const partyActs = (s: TableState) =>
	s.sw.fight === undefined || turnOf(s) === "ada";

const done = (reply: Reply) => {
	expect(reply.kind).toBe("done");
};

const loggedSince = (dir: string, seq: number) =>
	Effect.promise(
		async () => await readFile(path.join(dir, "events.jsonl"), "utf-8")
	).pipe(
		Effect.map((text) =>
			text
				.split("\n")
				.filter((line) => line !== "")
				.slice(seq)
				.map((line) => decodeLogged(line))
		)
	);

const message = (reply: Reply) =>
	reply.kind === "message" || reply.kind === "refusal" ? reply.text : "";

describe("/auto foes", () => {
	effect(
		"plays the foes' turns with ordinary logged commands, stopping at the party's turn",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaign("rules: set-world\n");
				yield* atTable(
					dir,
					Effect.gen(function* () {
						for (const line of [
							"/recruit Ada 101",
							"/foe Grub 501",
							"/map ford",
							"/place ada b5",
							"/place grub e5",
						]) {
							done(yield* runLine("gm", line));
						}

						expect(message(yield* runLine(alice, "/auto foes on"))).toBe(
							"Only the GM can use /auto."
						);
						expect(message(yield* runLine("gm", "/auto"))).toBe(
							"You play the foes' turns; /auto foes on lets the table play them."
						);
						expect(message(yield* runLine("gm", "/auto foes on"))).toStartWith(
							"The table plays the foes' turns now"
						);

						const before = (yield* state).seq;
						done(yield* runLine("gm", "/start"));
						let now = yield* until("the party's turn", partyActs);

						for (let turns = 0; turns < 6 && now.sw.fight !== undefined;) {
							const grub = now.sw.fighters.find((f) => f.id === "grub");

							if (grub?.at?.x === 2) {
								break;
							}

							done(yield* runLine("gm", "/done"));
							now = yield* until("the party's turn again", partyActs);
							turns += 1;
						}

						const logged = yield* loggedSince(dir, before);

						const foes = logged.filter(
							(e) => e.type === "sw.moved" || e.type === "sw.attacked"
						);

						expect(foes.length).toBeGreaterThan(0);
						expect(foes.every((e) => e.actor === "gm")).toBe(true);
						expect(logged.map((e) => e.type)).toContain("sw.attacked");
						expect(now.sw.fighters.find((f) => f.id === "grub")?.at).toEqual({
							x: 2,
							y: 4,
						});
						expect(turnOf(now) === "ada" || now.sw.fight === undefined).toBe(
							true
						);
					})
				);
			}),
		20_000
	);

	effect(
		"off again, the foes wait for the GM; a Draw Steel table has no /auto",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaign("rules: set-world\n");
				yield* atTable(
					dir,
					Effect.gen(function* () {
						for (const line of [
							"/recruit Ada 101",
							"/foe Grub 501",
							"/auto foes on",
							"/start",
						]) {
							const reply = yield* runLine("gm", line);
							expect(reply.kind === "done" || reply.kind === "message").toBe(
								true
							);
						}

						yield* until("the party's turn", partyActs);
						expect(message(yield* runLine("gm", "/auto foes off"))).toBe(
							"You play the foes' turns again."
						);

						let now = yield* state;

						for (let turns = 0; turns < 6 && turnOf(now) === "ada";) {
							done(yield* runLine("gm", "/done"));
							now = yield* state;
							turns += 1;
						}

						expect(turnOf(now)).toBe("grub");
						yield* Effect.sleep("50 millis");
						const later = yield* state;
						expect(later.seq).toBe(now.seq);
						expect(turnOf(later)).toBe("grub");
					})
				);

				const steel = yield* campaign(undefined);
				yield* atTable(
					steel,
					Effect.gen(function* () {
						expect(message(yield* runLine("gm", "/auto foes on"))).toStartWith(
							"Unknown command /auto."
						);
					})
				);
			}),
		20_000
	);
});
