import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Option } from "effect";

import { GmConfig } from "../../src/launcher/GmConfig.ts";
import { playedText } from "../../src/launcher/Launcher.tsx";
import { isBareName, scanCampaigns } from "../../src/launcher/scan.ts";
import { newWizard, tableSlug, wizardKey } from "../../src/launcher/wizard.ts";
import type {
	Wizard,
	WizardKey,
	WizardOutcome,
} from "../../src/launcher/wizard.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const campaign = async (dir: string, rules: string, playedAt?: Date) => {
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "campaign.yaml"), `rules: ${rules}\n`);

	if (playedAt !== undefined) {
		const log = path.join(dir, "events.jsonl");
		await writeFile(log, "");
		await utimes(log, playedAt, playedAt);
	}
};

const keys = (
	wizard: Wizard,
	pressed: ReadonlyArray<WizardKey>
): WizardOutcome => {
	let outcome: WizardOutcome = { kind: "editing", wizard };

	for (const key of pressed) {
		if (outcome.kind === "editing") {
			outcome = wizardKey(outcome.wizard, key);
		}
	}

	return outcome;
};

const typed = (text: string): Array<WizardKey> =>
	Array.from(text, (char) => ({ kind: "char", char }));

const ENTER: WizardKey = { kind: "enter" };

const EARLY = new Date(1000);

const LATER = new Date(2000);

const LATEST = new Date(9000);

describe("the launcher's scan", () => {
	effect(
		"finds the campaign here first, then ./*/ and the home's, newest played first",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const here = path.join(dir, "here");
				const home = path.join(dir, "home");

				yield* Effect.promise(async () => {
					await campaign(here, "draw-steel");
					await campaign(path.join(here, "sub"), "pf2e", EARLY);
					await mkdir(path.join(here, "not-one"));
					await writeFile(path.join(here, "stray.txt"), "");
					await campaign(path.join(home, "old"), "set-world", LATER);
					await campaign(path.join(home, "new"), "draw-steel", LATEST);
					await campaign(path.join(home, "never"), "draw-steel");
					await mkdir(path.join(home, ".hidden"));
					await campaign(path.join(home, "broken"), "chess");
				});

				const found = yield* scanCampaigns(here, home);

				expect(found.map((f) => [f.name, f.rules, f.here])).toEqual([
					["here", "draw-steel", true],
					["new", "draw-steel", false],
					["old", "set-world", false],
					["sub", "pf2e", false],
					["never", "draw-steel", false],
				]);
				expect(
					Option.map(found[1]?.lastPlayed ?? Option.none(), (d) => d.getTime())
				).toEqual(Option.some(9000));

				const elsewhere = yield* scanCampaigns(
					path.join(here, "not-one"),
					path.join(dir, "missing")
				);

				expect(elsewhere).toEqual([]);
			})
	);

	test("a bare name is a word, not a path", () => {
		expect(isBareName("ford")).toBe(true);
		expect(isBareName("ford-road")).toBe(true);
		expect(isBareName("./ford")).toBe(false);
		expect(isBareName("tables/ford")).toBe(false);
		expect(isBareName("ford.d")).toBe(false);
		expect(isBareName("")).toBe(false);
	});

	test("last played reads as a short time ago", () => {
		const found = {
			dir: "/x",
			name: "x",
			rules: "draw-steel" as const,
			here: false,
			lastPlayed: Option.none<Date>(),
		};

		expect(playedText(found, 0)).toBe("never played");
		expect(
			playedText({ ...found, lastPlayed: Option.some(new Date(0)) }, 30_000)
		).toBe("played just now");
		expect(
			playedText(
				{ ...found, lastPlayed: Option.some(new Date(0)) },
				3 * 3_600_000
			)
		).toBe("played 3 h ago");
		expect(
			playedText(
				{ ...found, lastPlayed: Option.some(new Date(0)) },
				5 * 86_400_000
			)
		).toBe("played 5 days ago");
	});
});

describe("the New Table wizard", () => {
	test("a name, its rules and the sample make a table, slugged", () => {
		expect(
			keys(newWizard(false), [...typed("Ford Road!"), ENTER, ENTER, ENTER])
		).toEqual({
			kind: "done",
			table: {
				slug: "ford-road",
				rules: "draw-steel",
				example: true,
				handle: undefined,
			},
		});
		expect(tableSlug("  The Keep: Part 2 ")).toBe("the-keep-part-2");
		expect(tableSlug("42 Café")).toBe("cafe");
	});

	test("other rules skip the sample; the sample can be turned down", () => {
		expect(
			keys(newWizard(false), [...typed("pit"), ENTER, { kind: "left" }, ENTER])
		).toEqual({
			kind: "done",
			table: {
				slug: "pit",
				rules: "freeform",
				example: false,
				handle: undefined,
			},
		});
		expect(
			keys(newWizard(false), [
				...typed("ford"),
				ENTER,
				ENTER,
				...typed("n"),
				ENTER,
			])
		).toMatchObject({ kind: "done", table: { example: false } });
	});

	test("it asks for a handle when none is saved, and checks it", () => {
		const asked = keys(newWizard(true), [
			...typed("ford"),
			ENTER,
			ENTER,
			ENTER,
			...typed("Ro"),
			{ kind: "back" },
			...typed("oot"),
			ENTER,
		]);

		expect(asked).toMatchObject({
			kind: "editing",
			wizard: {
				step: "handle",
				handle: "root",
				said: "The handle root is reserved on a relay; pick another.",
			},
		});

		expect(
			keys(newWizard(true), [
				...typed("ford"),
				ENTER,
				ENTER,
				ENTER,
				...typed("ana"),
				ENTER,
			])
		).toEqual({
			kind: "done",
			table: {
				slug: "ford",
				rules: "draw-steel",
				example: true,
				handle: "ana",
			},
		});
	});

	test("an empty name is refused; Esc steps back, and out", () => {
		expect(keys(newWizard(false), [ENTER])).toMatchObject({
			kind: "editing",
			wizard: { step: "name", said: "Name your table, e.g. Ford Road." },
		});
		expect(keys(newWizard(false), [...typed("123"), ENTER])).toMatchObject({
			wizard: { said: "A table's name needs a letter, e.g. Ford Road." },
		});
		expect(
			keys(newWizard(false), [...typed("ford"), ENTER, { kind: "escape" }])
		).toMatchObject({
			kind: "editing",
			wizard: { step: "name", name: "ford" },
		});
		expect(keys(newWizard(false), [{ kind: "escape" }])).toEqual({
			kind: "cancelled",
		});
	});
});

describe("gm.json", () => {
	effect(
		"reads as empty when missing, saves 0600, and reads back what it saved",
		() =>
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const folder = path.join(dir, "supervillain");
				const config = yield* GmConfig.make(folder);
				expect(config.path).toBe(path.join(folder, "gm.json"));
				expect(yield* config.read).toEqual({});
				yield* config.save({ handle: "ana", relay: "relay.example:7022" });
				expect(yield* config.read).toEqual({
					handle: "ana",
					relay: "relay.example:7022",
				});

				const info = yield* Effect.promise(async () => await stat(config.path));
				expect(info.mode % 0o1000).toBe(0o600);
				expect(
					yield* Effect.promise(
						async () => await readFile(config.path, "utf-8")
					)
				).toBe('{"handle":"ana","relay":"relay.example:7022"}\n');
			})
	);

	effect("says which file it can't understand", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			yield* Effect.promise(async () => {
				await writeFile(path.join(dir, "gm.json"), '{"handle": 7}');
			});
			const config = yield* GmConfig.make(dir);
			const failed = yield* Effect.flip(config.read);
			expect(failed.message).toStartWith(
				`can't understand ${path.join(dir, "gm.json")}:`
			);
		})
	);
});
