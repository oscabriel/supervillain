import { afterEach, describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";

import { App } from "../../src/table/App.tsx";
import { must } from "../game/must.ts";
import { fight, vex } from "./combat.ts";
import { alice, fakeView, gm } from "./fakeView.ts";
import { fordRoad } from "./maps.ts";
import {
	brann,
	campaignStage,
	emptyPrep,
	emptyStage,
	kesh,
} from "./stageViews.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const mount = async (
	fake: ReturnType<typeof fakeView>,
	width = 100,
	height = 45
) => {
	setup = await testRender(() => <App view={fake.view} />, {
		width,
		height,
		exitOnCtrlC: false,
		autoFocus: false,
	});
	await setup.renderOnce();

	return setup;
};

const settle = async (t: Setup) => {
	await Bun.sleep(1);
	await t.renderOnce();
	await Bun.sleep(1);
	await t.renderOnce();

	return t.captureCharFrame();
};

const enter = async (t: Setup, text: string) => {
	await t.mockInput.typeText(text);
	t.mockInput.pressEnter();

	return await settle(t);
};

const where = (t: Setup, text: string, from = 0) => {
	const rows = t.captureCharFrame().split("\n");

	for (let row = from; row < rows.length; row += 1) {
		const col = must(rows[row]).indexOf(text);

		if (col !== -1) {
			return { col, row };
		}
	}

	throw new Error(`'${text}' isn't on screen:\n${t.captureCharFrame()}`);
};

const click = async (t: Setup, text: string) => {
	const at = where(t, text);
	await t.mockMouse.click(at.col, at.row, undefined, { delayMs: 0 });

	return await settle(t);
};

const GM_NOTE = "GMSECRET the chief waits behind the cart.";

const NOTES = {
	"scene:ford-ambush": [{ kind: "para" as const, text: GM_NOTE }],
	"handout:wanted-poster": [
		{ kind: "para" as const, text: "GMSECRET Gall is the chief." },
	],
};

const seat = (over: Parameters<typeof fakeView>[0] = {}) =>
	fakeView({
		myName: "Alice",
		present: [gm, alice],
		stage: campaignStage,
		party: [brann, kesh],
		...over,
	});

describe("the campaign stage out of a fight", () => {
	test("the party strip and the stage take the band's and the map's places", async () => {
		const t = await mount(seat());
		const frame = t.captureCharFrame();

		expect(frame).toContain("party 2");
		expect(frame).toContain("Brann (Alice)  Stamina ██████░░ 15/20");
		expect(frame).toContain("Kesh");
		expect(frame).toContain("stage · Ambush at the Ford · codex 4");
		expect(frame).toContain(" read aloud ");
		expect(frame).toContain("The Ford Road runs down to the water.");
		expect(frame).toContain("• a ruined wall");
		expect(frame).toContain("Old Mara — Ferry-keeper");
		expect(frame).toContain("map · The Ford Road");
		expect(frame).toContain("◑ The alarm ●●○○ 2/4");
		expect(frame).toContain("• Mara waved, then didn't.");
		expect(frame).not.toContain("GM notes");
		expect(frame).not.toContain("at the table");
	});

	test("the GM's seat shows each card's GM notes, marked, under it", async () => {
		const t = await mount(seat({ me: "gm", myName: "Oscar", gmNotes: NOTES }));
		const frame = t.captureCharFrame();

		expect(frame).toContain("GM notes · only you see these");
		expect(frame).toContain(GM_NOTE);
	});

	test("a click on someone in the party asks for their sheet", async () => {
		const fake = seat();
		const t = await mount(fake);
		await click(t, "Brann (Alice)");

		expect(fake.submitted).toEqual(["/sheet brann"]);
	});

	test("a stage with nothing on it leaves the band and the feed as they were", async () => {
		const t = await mount(seat({ stage: emptyStage }));
		const frame = t.captureCharFrame();

		expect(frame).toContain("at the table");
		expect(frame).not.toContain("party 2");
		expect(frame).not.toContain("stage");
	});
});

describe("fights and the stage", () => {
	test("a fight brings the band and the board; its end brings the stage back", async () => {
		const fake = seat({ combat: null, map: null });
		const t = await mount(fake);

		expect(t.captureCharFrame()).toContain("Ambush at the Ford");

		fake.setMap(fordRoad);
		fake.setCombat(fight([vex]));
		fake.setStage({ ...campaignStage, mode: "encounter", combat: true });
		let frame = await settle(t);

		expect(frame).toContain("map · The Ford Road");
		expect(frame).toContain("round 2");
		expect(frame).not.toContain("party 2");
		expect(frame).not.toContain("read aloud");

		fake.setCombat(fight([vex], { active: false }));
		fake.setStage(campaignStage);
		frame = await settle(t);

		expect(frame).toContain("party 2");
		expect(frame).toContain("read aloud");
	});

	test("/view board and /view stage look at the other one, for this seat only", async () => {
		const fake = seat({ map: fordRoad });
		const t = await mount(fake);

		let frame = await enter(t, "/view board");

		expect(frame).toContain("you're looking at the board");
		expect(frame).not.toContain("read aloud");
		expect(frame).toContain("Ford Road");

		frame = await enter(t, "/view stage");

		expect(frame).toContain("read aloud");
		expect(fake.submitted).toEqual([]);
	});

	test("/view board with no map says so and keeps the stage", async () => {
		const t = await mount(seat());
		const frame = await enter(t, "/view board");

		expect(frame).toContain("no map is loaded, so there is no board");
		expect(frame).toContain("read aloud");
	});

	test("in a fight, /view stage peeks at the stage until the fight ends", async () => {
		const fake = seat({
			map: fordRoad,
			combat: fight([vex]),
			stage: { ...campaignStage, mode: "encounter", combat: true },
		});

		const t = await mount(fake);

		expect(t.captureCharFrame()).not.toContain("read aloud");
		expect(await enter(t, "/view stage")).toContain("read aloud");

		fake.setStage(campaignStage);
		fake.setCombat(undefined);
		expect(await settle(t)).toContain("read aloud");
	});
});

describe("the codex", () => {
	test("/codex lists what the table has seen; a click reads a card; Esc closes", async () => {
		const fake = seat();
		const t = await mount(fake);
		let frame = await enter(t, "/codex");

		expect(frame).toContain("← stage");
		expect(frame).toContain("✉ A wanted poster");
		expect(frame).toContain("◈ Ambush at the Ford  on the table");

		frame = await click(t, "✉ A wanted poster");

		expect(frame).toContain("| WANTED |");
		expect(frame).not.toContain("GMSECRET");

		t.mockInput.pressEscape();
		await Bun.sleep(40);
		frame = await settle(t);

		expect(frame).not.toContain("← stage");
		expect(frame).toContain("read aloud");
		expect(fake.submitted).toEqual([]);
	});

	test("the GM reading a card in the codex sees its notes too", async () => {
		const t = await mount(seat({ me: "gm", myName: "Oscar", gmNotes: NOTES }));
		const frame = await enter(t, "/codex wanted-poster");

		expect(frame).toContain("| WANTED |");
		expect(frame).toContain("GMSECRET Gall is the chief.");
	});

	test("the codex chip on the stage opens it", async () => {
		const t = await mount(seat());
		const title = where(t, "stage · Ambush");
		const chip = where(t, " codex 4 ", title.row + 1);
		await t.mockMouse.click(chip.col + 1, chip.row, undefined, { delayMs: 0 });

		expect(await settle(t)).toContain("← stage");
	});

	test("a card the codex doesn't hold, or a table without a stage, asks the host", async () => {
		const fake = seat();
		const t = await mount(fake);
		await enter(t, "/codex ghost");

		const bare = fakeView({ myName: "Alice" });
		setup?.renderer.destroy();
		const u = await mount(bare);
		await enter(u, "/codex");

		expect(fake.submitted).toEqual(["/codex ghost"]);
		expect(bare.submitted).toEqual(["/codex"]);
	});
});

describe("the prep panel's stage", () => {
	const stageSections = [
		{
			title: "scenes",
			items: [
				{
					kind: "send" as const,
					label: "Show Ambush at the Ford",
					line: "/show scene:ford-ambush",
				},
				{
					kind: "send" as const,
					label: "Codex Ambush at the Ford",
					line: "/reveal scene:ford-ambush",
				},
				{
					kind: "send" as const,
					label: "Start fight: Ambush at the Ford",
					line: "/map ford-road",
					lines: [
						"/map ford-road",
						"/add bandit-chief",
						"/add bandit-bruiser x2",
					],
				},
			],
		},
		{
			title: "npcs",
			items: [
				{
					kind: "send" as const,
					label: "Hide Old Mara",
					line: "/hide npc:old-mara",
					note: "on the table",
				},
			],
		},
	];

	const gmSeat = (over: Parameters<typeof fakeView>[0] = {}) =>
		fakeView({
			me: "gm",
			myName: "Oscar",
			present: [gm],
			prep: emptyPrep,
			prepStage: stageSections,
			...over,
		});

	test("each card has its buttons and tier; ▶ fight sends every line, in order", async () => {
		const fake = gmSeat();
		const t = await mount(fake);
		let frame = await enter(t, "/prep");

		expect(frame).toContain("scenes");
		expect(frame).toContain("Ambush at the Ford");
		expect(frame).toContain("◆ table");
		expect(frame).toContain(" Show ");

		frame = await click(t, "▶ fight");
		await settle(t);

		expect(fake.submitted).toEqual([
			"/map ford-road",
			"/add bandit-chief",
			"/add bandit-bruiser x2",
		]);

		await click(t, " Hide ");

		expect(fake.submitted.at(-1)).toBe("/hide npc:old-mara");
	});

	test("▶ fight stops at the first refusal, which stays on screen", async () => {
		const fake = gmSeat({
			reply: async (line) =>
				await Promise.resolve(
					line === "/map ford-road" ? "No map ford-road." : undefined
				),
		});

		const t = await mount(fake);
		await enter(t, "/prep");
		await click(t, "▶ fight");
		const frame = await settle(t);

		expect(fake.submitted).toEqual(["/map ford-road"]);
		expect(frame).toContain("No map ford-road.");
	});

	test("changed sheets offer one click to sync them", async () => {
		const fake = gmSeat({
			sync: {
				kind: "send",
				label: "Sync Brann",
				line: "/hero brann",
				lines: ["/hero brann"],
			},
		});

		const t = await mount(fake);
		const frame = await enter(t, "/prep");

		expect(frame).toContain("sheets changed");
		expect(frame).toContain("Sync Brann");

		await click(t, "↻ sync");

		expect(fake.submitted).toEqual(["/hero brann"]);
	});

	test("a problem in the files shows in the header and the panel, and play goes on", async () => {
		const fake = gmSeat({
			contentProblems: ["scenes/ford-ambush.md: weather is not a field"],
		});

		const t = await mount(fake);
		let frame = t.captureCharFrame();

		expect(frame).toContain("a campaign file has a problem · /prep shows it");

		frame = await enter(t, "/prep");

		expect(frame).toContain("⚠ a file has a problem");
		expect(frame).toContain("weather is not a field");

		fake.setProblems([]);
		frame = await settle(t);

		expect(frame).not.toContain("a campaign file has a problem");
	});
});
