import { describe, expect, test } from "bun:test";

import {
	afterClaim,
	commandsOf,
	commandsText,
	createForm,
	createKey,
	INSTALL_COMMAND,
	keyed,
	KEYLESS_CREATE,
	lobbyFrame,
	lobbying,
	osc52,
	afterPairing,
	shellLines,
} from "../../src/relay/lobby/index.ts";
import type {
	CreateForm,
	CreateKey,
	Keyed,
	Lobbying,
	LobbyScreen,
} from "../../src/relay/lobby/index.ts";

const ROOMS = ["ana/ford", "ana/keep"];

const press = (state: Lobbying, text: string, rooms = ROOMS) => {
	const bytes = Buffer.from(text, "latin1");
	const steps: Array<Keyed> = [];

	for (const [at, byte] of bytes.entries()) {
		steps.push(keyed(state, rooms, bytes, at, byte));
	}

	return steps.filter((step) => step.kind !== "more");
};

const fresh = (guest = false, held?: string) =>
	lobbying(createForm(guest, held), { picked: 0, said: undefined });

const typeInto = (form: CreateForm, keys: ReadonlyArray<CreateKey>) => {
	let now = form;
	const asks: Array<unknown> = [];

	for (const key of keys) {
		const stepped = createKey(now, key);
		now = stepped.form;

		if (stepped.ask !== undefined) {
			asks.push(stepped.ask);
		}
	}

	return { form: now, asks };
};

const chars = (text: string): Array<CreateKey> =>
	Array.from(text, (char) => ({ kind: "char", char }));

describe("the lobby's keys", () => {
	test("Tab, Shift+Tab, F1-F3 (both forms) and Alt+1-3 switch tabs", () => {
		const state = fresh();
		expect(state.tab).toBe("tables");
		press(state, "\t");
		expect(state.tab).toBe("try");
		press(state, "\t");
		expect(state.tab).toBe("create");
		press(state, "\t");
		expect(state.tab).toBe("tables");
		press(state, "\u001B[Z");
		expect(state.tab).toBe("create");

		for (const [keys, tab] of [
			["\u001BOP", "tables"],
			["\u001BOQ", "try"],
			["\u001BOR", "create"],
			["\u001B[11~", "tables"],
			["\u001B[12~", "try"],
			["\u001B[13~", "create"],
			["\u001B1", "tables"],
			["\u001B2", "try"],
			["\u001B3", "create"],
		] as const) {
			press(state, keys);
			expect(state.tab).toBe(tab);
		}
	});

	test("digits pick from the list on Tab 1 and nowhere else; a switch clears what was said", () => {
		const state = fresh();
		press(state, "2");
		expect(state.picked).toBe(1);
		expect(press(state, "\r")).toEqual([
			{ kind: "chose", room: "ana/keep", skip: 1 },
		]);
		state.said = "There's no 7 on the list.";
		press(state, "\u001B2");
		expect(state.said).toBeUndefined();
		press(state, "1");
		expect(state.picked).toBe(1);
		expect(press(state, "\r\n")).toEqual([{ kind: "try", skip: 2 }]);
	});

	test("on Tab 3 a key holder types a handle, and Enter asks the relay to claim it", () => {
		const state = fresh();
		press(state, "\u001B3");
		press(state, "Ana-1\u007F\u007F");
		expect(state.create.handle).toBe("ana");
		expect(press(state, "\r")).toEqual([
			{ kind: "ask", ask: { kind: "claim", handle: "ana" }, skip: 1 },
		]);
		state.create = afterClaim(state.create, { kind: "held", handle: "ana" });
		press(state, "ford\u001B[C");
		expect(state.create).toMatchObject({
			step: "table",
			table: "ford",
			rules: "set-world",
		});
		expect(press(state, "\r")).toEqual([
			{
				kind: "ask",
				ask: { kind: "mint", handle: "ana", table: "ford", rules: "set-world" },
				skip: 1,
			},
		]);
	});

	test("a guest's Tab 3 takes no keys, and Ctrl-C or Ctrl-D leaves from any tab", () => {
		const state = fresh(true);
		press(state, "\u001B3ana\r");
		expect(state.create).toEqual(createForm(true, undefined));
		expect(press(state, "\u0003")).toEqual([{ kind: "left" }]);
		expect(press(fresh(), "\u001B2\u0004")).toEqual([{ kind: "left" }]);
	});
});

describe("the Create a Table form", () => {
	test("a handle the key holds already is kept, and Enter moves on", () => {
		const held = createForm(false, "ana");
		expect(held).toMatchObject({ step: "handle", handle: "ana" });
		const moved = typeInto(held, [...chars("xyz"), { kind: "enter" }]);
		expect(moved.form).toMatchObject({
			step: "table",
			handle: "ana",
			table: "",
		});
		expect(moved.asks).toEqual([]);
	});

	test("handles and table names are checked before the relay is asked", () => {
		const form = createForm(false, undefined);
		expect(typeInto(form, [{ kind: "enter" }]).form.said).toBe(
			"Type the handle you want, then Enter."
		);
		expect(
			typeInto(form, [...chars("9ana"), { kind: "enter" }]).form.said
		).toContain("A handle is 1-24 of a-z");
		expect(
			typeInto(form, [...chars("root"), { kind: "enter" }]).form.said
		).toBe("The handle root is reserved; pick another.");

		const table = afterClaim(form, { kind: "held", handle: "ana" });
		expect(table.said).toBe("You hold ana now.");
		expect(typeInto(table, [{ kind: "enter" }]).form.said).toBe(
			"Type your table's name, then Enter."
		);
		expect(
			typeInto(table, [...chars("-x"), { kind: "enter" }]).form.said
		).toContain("A table's name is 1-32");
		expect(afterClaim(form, { kind: "refused", reason: "no" }).said).toBe("no");
	});

	test("←/→ cycle the rules; Backspace on an empty name goes back to an unheld handle", () => {
		const form = {
			...createForm(false, undefined),
			step: "table" as const,
			handle: "ana",
		};

		expect(typeInto(form, [{ kind: "left" }]).form.rules).toBe("freeform");
		expect(
			typeInto(form, [{ kind: "right" }, { kind: "right" }]).form.rules
		).toBe("pf2e");
		expect(typeInto(form, [{ kind: "back" }]).form.step).toBe("handle");
		expect(
			typeInto({ ...form, held: "ana" }, [{ kind: "back" }]).form.step
		).toBe("table");
	});

	test("a minted code readies the commands; a refusal is said", () => {
		const form = {
			...createForm(false, "ana"),
			step: "table" as const,
			table: "ford",
			rules: "pf2e" as const,
		};

		const ready = afterPairing(form, {
			kind: "minted",
			code: "sv-abcdefghjkmnpqrstvwx",
			until: 9,
		});

		expect(ready.step).toBe("ready");
		expect(createKey(ready, { kind: "char", char: "x" }).form).toBe(ready);

		const commands = commandsOf(ready, {
			code: "sv-abcdefghjkmnpqrstvwx",
			until: 9,
		});

		expect(commands).toEqual({
			install: "curl -fsSL https://supervillain.sh/install | sh",
			create:
				"supervillain new ford --rules pf2e --handle ana --claim sv-abcdefghjkmnpqrstvwx",
		});
		expect(commandsText(commands)).toBe(
			`${INSTALL_COMMAND}\n${commands.create}`
		);

		const elsewhere = {
			...ready,
			relay: createForm(false, "ana", "relay.example:7022").relay,
		};

		expect(
			commandsOf(elsewhere, { code: "sv-abcdefghjkmnpqrstvwx", until: 9 })
				.create
		).toBe(
			"supervillain new ford --rules pf2e --handle ana --claim sv-abcdefghjkmnpqrstvwx --relay relay.example:7022"
		);
		expect(createForm(false, "ana", "supervillain.sh:7022").relay).toBe(
			undefined
		);
		expect(
			afterPairing(form, { kind: "refused", reason: "slow down" }).said
		).toBe("slow down");
	});
});

describe("OSC 52", () => {
	test("puts base64 on the clipboard, wrapped for tmux and screen", () => {
		const plain = osc52("hi", "xterm-256color");
		expect(plain).toBe("\u001B]52;c;aGk=\u0007");
		expect(osc52("hi", "tmux-256color")).toBe(
			"\u001BPtmux;\u001B\u001B]52;c;aGk=\u0007\u001B\\"
		);
		expect(osc52("hi", "screen.xterm-256color")).toBe(
			"\u001BP\u001B]52;c;aGk=\u0007\u001B\\"
		);
		expect(osc52("x".repeat(80_000), "xterm")).toBe("");
	});

	test("never ends the clipboard with a newline, so a paste never runs on its own", () => {
		const copied = osc52(
			`${INSTALL_COMMAND}\nsupervillain new ford\n`,
			"xterm"
		);

		const body = copied.slice("\u001B]52;c;".length, -1);

		const text = Buffer.from(body, "base64").toString("utf-8");

		expect(text).toBe(`${INSTALL_COMMAND}\nsupervillain new ford`);
		expect(text.endsWith("\n")).toBe(false);
	});

	test("wraps for tmux when TMUX or TERM_PROGRAM says so, even under TERM=screen, and chunks for GNU screen", () => {
		const tmuxed = "\u001BPtmux;\u001B\u001B]52;c;aGk=\u0007\u001B\\";
		expect(
			osc52("hi", "screen-256color", { TMUX: "/tmp/tmux-1/default,1,0" })
		).toBe(tmuxed);
		expect(osc52("hi", "screen", { TERM_PROGRAM: "tmux" })).toBe(tmuxed);

		const long = osc52("y".repeat(200), "screen");
		const pieces = long.split("\u001B\\").filter((piece) => piece !== "");
		expect(pieces.length).toBeGreaterThan(1);

		for (const piece of pieces) {
			expect(piece.startsWith("\u001BP")).toBe(true);
			expect(piece.length).toBeLessThanOrEqual(78);
		}

		expect(pieces.map((piece) => piece.slice(2)).join("")).toBe(
			osc52("y".repeat(200), "xterm")
		);
	});
});

const text = (screen: LobbyScreen, cols = 100, rows = 30) =>
	Bun.stripANSI(lobbyFrame(screen, cols, rows));

const fits = (screen: LobbyScreen) => {
	for (const [cols, rows] of [
		[60, 20],
		[80, 24],
		[100, 30],
		[140, 40],
	] as const) {
		const lines = Bun.stripANSI(lobbyFrame(screen, cols, rows)).split("\r\n");
		expect(lines.length).toBeLessThanOrEqual(rows);

		for (const line of lines) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
		}
	}
};

describe("the lobby's tabs, drawn", () => {
	const base: LobbyScreen = {
		tables: [],
		picked: 0,
		typed: "",
		you: {
			key: { fingerprint: "SHA256:abc", algorithm: "ssh-ed25519" },
			term: "xterm-256color",
		},
		sandbox: {
			open: true,
			cols: 100,
			rows: 30,
			idleMinutes: 5,
			maxMinutes: 20,
		},
	};

	test("a tab bar names the three tabs on every tab", () => {
		for (const tab of ["tables", "try", "create"] as const) {
			const shown = text({ ...base, tab });
			expect(shown).toContain(" 1 Tables ");
			expect(shown).toContain(" 2 Try a Table ");
			expect(shown).toContain(" 3 Create a Table ");
			fits({ ...base, tab });
		}

		expect(text(base)).toContain("tab more");
	});

	test("Try a Table explains the sandbox, or that there is none", () => {
		const shown = text({ ...base, tab: "try" });
		expect(shown).toContain("a Draw Steel table to play by yourself");
		expect(shown).toContain("Nothing is saved");
		expect(shown).toContain("try a table   enter");
		expect(shown).toContain("a terminal of 100×30 or more");
		expect(shown).toContain("after 5 min idle, 20 min in all");
		expect(shown).toContain("> Enter opens your sandbox table");

		const off = text({
			...base,
			tab: "try",
			sandbox: {
				open: false,
				cols: 100,
				rows: 30,
				idleMinutes: 5,
				maxMinutes: 20,
			},
		});

		expect(off).toContain("this relay offers no sandbox tables");
	});

	test("Create a Table walks a guest off, then handle, table and the ready commands", () => {
		const guest = text({
			...base,
			you: { key: undefined, term: "xterm" },
			tab: "create",
			create: createForm(true, undefined),
		});

		expect(guest.replaceAll(/\s+/gu, " ")).toContain(KEYLESS_CREATE);

		const typing = text({
			...base,
			tab: "create",
			create: { ...createForm(false, undefined), handle: "an" },
		});

		expect(typing).toContain("Pick your GM handle.");
		expect(typing.split("\r\n").some((line) => line.trim() === "> an")).toBe(
			true
		);

		expect(
			text({ ...base, tab: "create", create: createForm(false, "ana") })
		).toContain("● You hold ana");

		const form: CreateForm = {
			...createForm(false, "ana"),
			step: "table",
			table: "ford",
		};

		expect(text({ ...base, tab: "create", create: form })).toContain(
			"‹ draw-steel ›  set-world  pf2e"
		);

		const ready = afterPairing(form, {
			kind: "minted",
			code: "sv-abcdefghjkmnpqrstvwx",
			until: 9,
		});

		const screen: LobbyScreen = { ...base, tab: "create", create: ready };
		const shown = text(screen);
		expect(shown).toContain("curl -fsSL https://supervillain.sh/install | sh");
		expect(shown).toContain(
			"supervillain new ford --rules draw-steel --handle ana --claim sv-abcdefghjkmnpqrstvwx"
		);
		fits(screen);
		const narrow = text(screen, 60, 30);
		expect(narrow).toContain(
			"supervillain new ford --rules draw-steel --handle ana \\\r\n    --claim sv-abcdefghjkmnpqrstvwx"
		);
	});

	test("a long command wraps at spaces with shell continuations", () => {
		expect(shellLines("a b c", 10)).toEqual(["a b c"]);
		expect(shellLines("one two three four", 12)).toEqual([
			"one two \\",
			"  three \\",
			"  four",
		]);
	});
});
