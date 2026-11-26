import { afterEach, describe, expect, test } from "bun:test";

import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

import { App } from "../../src/table/App.tsx";
import { Doorway } from "../../src/table/Doorway.tsx";
import { keyAction } from "../../src/table/input.ts";
import {
	INVITE_INTRO,
	KNOCK_INTRO,
	waitingText,
} from "../../src/table/Knock.tsx";
import type {
	KnockStatus,
	KnockView,
	TableView,
} from "../../src/table/view.ts";
import { fakeView, gm } from "./fakeView.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const ANA = {
	actor: "key:SHA256:ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34abc",
	name: "Ana",
	short: "ab12cd34",
};

const BO = { actor: "guest:bo", name: "Bo", short: "guest:bo" };

const key = (name: string, meta: boolean) => ({
	name,
	ctrl: false,
	meta,
	shift: false,
	sequence: name,
});

const settle = async (t: Setup) => {
	await Bun.sleep(30);
	await t.renderOnce();

	return t.captureCharFrame();
};

const mountApp = async (fake: ReturnType<typeof fakeView>) => {
	setup = await testRender(() => <App view={fake.view} />, {
		width: 100,
		height: 30,
		exitOnCtrlC: false,
		autoFocus: false,
	});
	await setup.renderOnce();

	return setup;
};

const gmTable = () =>
	fakeView({
		me: "gm",
		present: [gm],
		knocks: [ANA, BO],
	});

describe("the GM's knock banner", () => {
	test("shows the oldest knock with its key, how many more wait, and nothing once none do", async () => {
		const fake = gmTable();
		const t = await mountApp(fake);
		const frame = await settle(t);
		const banner = frame.split("\n").find((row) => row.includes("knocks"));
		expect(banner).toContain("⚑ Ana (ab12cd34) knocks · [Admit] [Deny]");
		expect(banner).toContain("Alt+Y / Alt+N · 1 more knocking");
		fake.setKnocks([]);
		expect(await settle(t)).not.toContain("knocks ·");
	});

	test("[Admit] and [Deny] answer the oldest knock by its key", async () => {
		const fake = gmTable();
		const t = await mountApp(fake);
		const frame = await settle(t);
		const rows = frame.split("\n");
		const row = rows.findIndex((r) => r.includes("[Admit]"));
		const at = (rows[row] ?? "").indexOf("[Admit]");
		await t.mockMouse.click(at + 2, row, undefined, { delayMs: 0 });
		await settle(t);
		expect(fake.submitted).toEqual([`/admit ${ANA.actor}`]);
		const deny = (rows[row] ?? "").indexOf("[Deny]");
		await t.mockMouse.click(deny + 2, row, undefined, { delayMs: 0 });
		await settle(t);
		expect(fake.submitted).toEqual([
			`/admit ${ANA.actor}`,
			`/deny ${ANA.actor}`,
		]);
	});

	test("Alt+Y lets the oldest in and Alt+N turns them away", async () => {
		const fake = gmTable();
		const t = await mountApp(fake);
		await settle(t);
		t.mockInput.pressKey("y", { meta: true });
		await settle(t);
		t.mockInput.pressKey("n", { meta: true });
		await settle(t);
		expect(fake.submitted).toEqual([
			`/admit ${ANA.actor}`,
			`/deny ${ANA.actor}`,
		]);
	});

	test("a table with nobody knocking ignores Alt+Y", async () => {
		const fake = fakeView({ me: "gm", present: [gm] });
		const t = await mountApp(fake);
		t.mockInput.pressKey("y", { meta: true });
		await settle(t);
		expect(fake.submitted).toEqual([]);
	});

	test("Alt+Y and Alt+N are knock keys; plain y and n are typing", () => {
		expect(keyAction(key("y", true))).toEqual({
			kind: "knock",
			verdict: "admit",
		});
		expect(keyAction(key("n", true))).toEqual({
			kind: "knock",
			verdict: "deny",
		});
		expect(keyAction(key("y", false))).toEqual({ kind: "insert", text: "y" });
	});
});

const door = (status: KnockStatus, answer?: string) => {
	const [shown, setShown] = createSignal<KnockStatus>(status);
	const [table, setTable] = createSignal<TableView>();
	const asked: Array<string> = [];
	let left = 0;

	const view: KnockView = {
		room: "den",
		me: "ab12cd34",
		status: shown,
		knock: async (name) => {
			asked.push(name);

			return await Promise.resolve(answer);
		},
		leave: () => {
			left += 1;
		},
	};

	return { view, asked, setShown, table, setTable, left: () => left };
};

const mountDoor = async (fake: ReturnType<typeof door>) => {
	setup = await testRender(
		() => <Doorway knock={fake.view} table={fake.table} />,
		{ width: 100, height: 30, exitOnCtrlC: false, autoFocus: false }
	);
	await setup.renderOnce();

	return setup;
};

describe("the door", () => {
	test("asks a knocker's name, sends it, and says when the name won't do", async () => {
		const fake = door(
			{ kind: "naming", invited: false },
			'"GM" is taken; pick another name.'
		);

		const t = await mountDoor(fake);
		const first = await settle(t);
		expect(first).toContain("den · at the door");
		expect(first).toContain(KNOCK_INTRO.slice(0, 40));
		expect(first).toContain("Your key: ab12cd34");
		expect(first).toContain("what should the table call you?");
		await t.mockInput.typeText("GM");
		t.mockInput.pressEnter();
		expect(await settle(t)).toContain('"GM" is taken; pick another name.');
		expect(fake.asked).toEqual(["GM"]);
	});

	test("an invited player is told so; a waiting one sees their name and key", async () => {
		const fake = door({ kind: "naming", invited: true });
		const t = await mountDoor(fake);
		expect(await settle(t)).toContain(INVITE_INTRO.slice(0, 40));
		fake.setShown({ kind: "waiting", name: "Ana" });
		const waiting = await settle(t);
		expect(waiting).toContain(
			`⚑ ${waitingText("Ana", "ab12cd34").slice(0, 60)}`
		);
		await t.mockInput.typeText("ignored");
		t.mockInput.pressEnter();
		await settle(t);
		expect(fake.asked).toEqual([]);
		fake.setShown({
			kind: "turned",
			text: "The GM didn't let you in this time.",
		});
		expect(await settle(t)).toContain("The GM didn't let you in this time.");
	});

	test("Ctrl-C leaves the door, and once let in the table takes the screen", async () => {
		const fake = door({ kind: "waiting", name: "Ana" });
		const t = await mountDoor(fake);
		t.mockInput.pressCtrlC();
		expect(fake.left()).toBe(1);
		fake.setTable(fakeView({ room: "den", myName: "Ana" }).view);
		const seated = await settle(t);
		expect(seated).not.toContain("at the door");
		expect(seated).toContain("say something, or /help");
	});
});
