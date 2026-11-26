import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { Cause, Effect, Exit, Fiber, Option } from "effect";

import { launcherFrame, playedText } from "../../src/launcher/frame.ts";
import { GmConfig } from "../../src/launcher/GmConfig.ts";
import {
	flushLauncherEscape,
	launcherKeyed,
	launching,
} from "../../src/launcher/keys.ts";
import type { LauncherChoice } from "../../src/launcher/keys.ts";
import {
	ENTER_ALT_SCREEN,
	LEAVE_ALT_SCREEN,
	runLauncher,
} from "../../src/launcher/run.ts";
import type {
	LauncherProps,
	LauncherTerminal,
} from "../../src/launcher/run.ts";
import { isBareName, scanCampaigns } from "../../src/launcher/scan.ts";
import type { FoundCampaign } from "../../src/launcher/scan.ts";
import { newWizard, tableSlug, wizardKey } from "../../src/launcher/wizard.ts";
import type {
	Wizard,
	WizardKey,
	WizardOutcome,
} from "../../src/launcher/wizard.ts";
import { effect, waitFor } from "../host/effect.ts";
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

const feedBytes = (
	state: ReturnType<typeof launching>,
	campaigns: ReadonlyArray<FoundCampaign>,
	relay: string | undefined,
	handle: string | undefined,
	input: string
): LauncherChoice | undefined => {
	let chosen: LauncherChoice | undefined;

	for (const byte of Buffer.from(input, "utf-8")) {
		const step = launcherKeyed(state, campaigns, relay, handle, byte);

		if (step.kind === "done") {
			chosen = step.choice;
			break;
		}
	}

	return chosen;
};

describe("the unified launcher TUI", () => {
	const sample: ReadonlyArray<FoundCampaign> = [
		{
			dir: "/home/gm/supervillain/keep",
			name: "keep",
			rules: "pf2e",
			here: false,
			lastPlayed: Option.none(),
		},
	];

	test("renders the same 4-tab chrome as the SSH lobby", () => {
		const state = launching(false);

		const plain = Bun.stripANSI(
			launcherFrame(
				{
					state,
					campaigns: sample,
					home: "/home/gm/supervillain",
					handle: "ana",
					relay: "supervillain.sh",
					term: "xterm-256color",
					now: 0,
				},
				120,
				34
			)
		);

		expect(plain).toContain("1 Tables");
		expect(plain).toContain("2 Try a Table");
		expect(plain).toContain("3 Create a Table");
		expect(plain).toContain("4 Session");
		expect(plain).toContain("keep");
		expect(plain).toContain("PF2e (ORC)");
		expect(plain).toContain("ssh ana/keep@supervillain.sh");
	});

	test("switches tabs with 1-4 and opens Try a Table with Enter", () => {
		const state = launching(false);
		expect(feedBytes(state, sample, undefined, undefined, "2")).toBeUndefined();
		expect(state.tab).toBe("try");

		const tryPlain = Bun.stripANSI(
			launcherFrame(
				{
					state,
					campaigns: sample,
					home: "/home/gm/supervillain",
					handle: undefined,
					relay: undefined,
					term: "xterm-256color",
					now: 0,
				},
				100,
				30
			)
		);

		expect(tryPlain).toContain("Solo Draw Steel sandbox");
		expect(feedBytes(state, sample, undefined, undefined, "\r")).toEqual({
			kind: "try",
		});
	});

	test("jumps to Create a Table with n, steps through wizard, and handles Esc", () => {
		const state = launching(false);
		expect(feedBytes(state, sample, undefined, undefined, "n")).toBeUndefined();
		expect(state.tab).toBe("create");
		expect(state.editing).toBe(true);

		expect(
			feedBytes(state, sample, undefined, undefined, "Ford Road\r\r\r")
		).toEqual({
			kind: "new",
			table: {
				slug: "ford-road",
				rules: "draw-steel",
				example: true,
				handle: undefined,
			},
		});

		const cancelling = launching(false);
		feedBytes(cancelling, sample, undefined, undefined, "n\u001B");
		expect(flushLauncherEscape(cancelling)).toBe(true);
		expect(cancelling.editing).toBe(false);
		expect(feedBytes(cancelling, sample, undefined, undefined, "q")).toEqual({
			kind: "quit",
		});
	});
});

const FRAME_START = "\u001B[H\u001B[2J";

const fakeTerminal = (breaksAtFrame?: number) => {
	const written: Array<string> = [];
	const raw: Array<boolean> = [];
	const resizes = new Set<() => void>();
	const keyboard = new PassThrough();
	let frames = 0;

	const terminal: LauncherTerminal = {
		stdin: Object.assign(keyboard, {
			isRaw: false,
			setRawMode: (on: boolean) => {
				raw.push(on);
			},
		}),
		stdout: {
			columns: 100,
			rows: 30,
			write: (text) => {
				if (text.startsWith(FRAME_START)) {
					frames += 1;

					if (frames === breaksAtFrame) {
						throw new Error("the frame broke");
					}
				}

				written.push(text);
			},
			on: (_event, listener) => {
				resizes.add(listener);
			},
			removeListener: (_event, listener) => {
				resizes.delete(listener);
			},
		},
	};

	return { terminal, keyboard, written, raw, resizes, frames: () => frames };
};

describe("the launcher's terminal", () => {
	const props: LauncherProps = {
		campaigns: [],
		home: "/home/gm/supervillain",
		handle: undefined,
		relay: undefined,
		term: "xterm-256color",
		now: 0,
	};

	effect("is handed back when a choice is made", () =>
		Effect.gen(function* () {
			const { terminal, keyboard, written, raw, resizes, frames } =
				fakeTerminal();

			const fiber = yield* Effect.forkChild(runLauncher(props, terminal));
			yield* waitFor("the first frame", () => frames() === 1);
			expect(written[0]).toBe(ENTER_ALT_SCREEN);
			expect(raw).toEqual([true]);
			expect(resizes.size).toBe(1);

			for (const resized of resizes) {
				resized();
			}

			expect(frames()).toBe(2);
			keyboard.write("2\r");
			expect(yield* Fiber.join(fiber)).toEqual({ kind: "try" });
			expect(written.at(-1)).toBe(LEAVE_ALT_SCREEN);
			expect(raw).toEqual([true, false]);
			expect(resizes.size).toBe(0);
		})
	);

	effect("is handed back when the launcher is interrupted", () =>
		Effect.gen(function* () {
			const { terminal, written, raw, resizes, frames } = fakeTerminal();
			const fiber = yield* Effect.forkChild(runLauncher(props, terminal));
			yield* waitFor("the first frame", () => frames() === 1);
			expect(written).not.toContain(LEAVE_ALT_SCREEN);
			yield* Fiber.interrupt(fiber);
			expect(written.at(-1)).toBe(LEAVE_ALT_SCREEN);
			expect(raw).toEqual([true, false]);
			expect(resizes.size).toBe(0);
		})
	);

	effect("is handed back when drawing a frame throws", () =>
		Effect.gen(function* () {
			for (const breaksAt of [1, 2]) {
				const { terminal, keyboard, written, raw, frames } =
					fakeTerminal(breaksAt);

				const fiber = yield* Effect.forkChild(runLauncher(props, terminal));
				yield* waitFor("the first frame", () => frames() === 1);
				keyboard.write("j");
				const exit = yield* Fiber.await(fiber);
				expect(Exit.hasDies(exit)).toBe(true);
				expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
					"the frame broke"
				);
				expect(written.at(-1)).toBe(LEAVE_ALT_SCREEN);
				expect(raw).toEqual([true, false]);
			}
		})
	);
});
