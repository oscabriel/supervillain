/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import { RESERVED_PANEL_KEYS } from "@supervillain/core";
import type {
	GamePanel,
	GamePanelInput,
	MessageTask,
	PanelKeyGroup,
	TableView,
} from "@supervillain/core";

import { apply, init } from "../src/model.js";
import type { DsCommand, DsEvent, DsState } from "../src/model.js";
import { view } from "../src/view.js";

/** The no-secret-keys probe alphabet: every `PanelKey.name` the Table chrome
 * can dispatch to a Panel. Kept byte-identical with the fake module's
 * conformance spec — core ships no harness (ADR-0031), so the copies bind each
 * other; a key added here must be added there. */
const CANONICAL_KEY_NAMES = [
	..."abcdefghijklmnopqrstuvwxyz",
	..."0123456789",
	"up",
	"down",
	"left",
	"right",
	"return",
	"enter",
	"escape",
	"space",
	"tab",
	"pageup",
	"pagedown",
	"home",
	"end",
	"delete",
	"backspace",
	"insert",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"-",
	"_",
	"=",
	"+",
	"[",
	"]",
	"{",
	"}",
	"\\",
	"|",
	";",
	":",
	"'",
	'"',
	",",
	".",
	"/",
	"<",
	">",
	"?",
	"`",
] as const;

const table: TableView = {
	actor: "gm-key",
	gmSeatId: "gm",
	seats: [{ actor: "gm-key", characterId: "Coda", id: "gm" }],
};

const createLivePanelState = (): DsState => {
	let state = init();
	for (const event of [
		{
			sheet: {
				abilities: [],
				ancestry: "Human",
				characteristics: {
					agility: 1,
					intuition: 1,
					might: 2,
					presence: 2,
					reason: 0,
				},
				className: "Troubadour",
				heroicResource: "Drama",
				kit: null,
				name: "Coda",
				recoveries: 8,
				stamina: 20,
				surges: 0,
				victories: 0,
			},
			type: "ds.character-entered",
		},
		{ type: "ds.encounter-started" },
		{ id: "c1", name: "Coda", side: "heroes", type: "ds.combatant-added" },
	] satisfies DsEvent[]) {
		state = apply(state, event);
	}
	return state;
};

interface InputRecorder {
	readonly dispatches: DsCommand[];
	readonly input: GamePanelInput<DsState, DsCommand>;
	readonly tasks: MessageTask<DsCommand>[];
}

const createInput = (): InputRecorder => {
	const dispatches: DsCommand[] = [];
	const tasks: MessageTask<DsCommand>[] = [];
	return {
		dispatches,
		input: {
			dispatch: (command) => dispatches.push(command),
			focused: true,
			requestMessageTask: (task) => tasks.push(task),
			state: createLivePanelState(),
			table,
		},
		tasks,
	};
};

const panelAt = (index: number): GamePanel<DsState, DsCommand> => {
	const panel = view.createPanels()[index];
	if (panel?.onKey === undefined || panel.keySurface === undefined) {
		throw new Error(`interactive nominated panel ${index} missing`);
	}
	return panel;
};

const groupNamed = (
	panel: GamePanel<DsState, DsCommand>,
	title: string
): PanelKeyGroup => {
	const group = panel.keySurface?.find(
		(candidate) => candidate.title === title
	);
	if (group === undefined) {
		throw new Error(`key group ${title} missing`);
	}
	return group;
};

const nominatedKeys = (panel: GamePanel<DsState, DsCommand>): Set<string> =>
	new Set(
		(panel.keySurface ?? []).flatMap((group) =>
			group.bindings.flatMap((binding) => binding.keys)
		)
	);

const createInitiativeFixture = (
	mode: "initiative" | "roll setup"
): {
	readonly input: GamePanelInput<DsState, DsCommand>;
	readonly panel: GamePanel<DsState, DsCommand>;
} => {
	const panel = panelAt(0);
	const { input } = createInput();
	if (mode === "roll setup") {
		expect(panel.onKey?.({ name: "r" }, input)).toBe(true);
	}
	return { input, panel };
};

const createSheetFixture = (): {
	readonly input: GamePanelInput<DsState, DsCommand>;
	readonly panel: GamePanel<DsState, DsCommand>;
} => ({ input: createInput().input, panel: panelAt(1) });

describe("Draw Steel Panel key-surface conformance", () => {
	test.each(["initiative", "roll setup"] as const)(
		"claims every key nominated by the %s group",
		(mode) => {
			const sourcePanel = panelAt(0);
			const group = groupNamed(sourcePanel, mode);
			for (const keyName of group.bindings.flatMap((binding) => binding.keys)) {
				const { input, panel } = createInitiativeFixture(mode);
				expect(panel.onKey?.({ name: keyName }, input)).toBe(true);
			}
		}
	);

	test("claims every key nominated by the sheets group", () => {
		const group = groupNamed(panelAt(1), "sheets");
		for (const keyName of group.bindings.flatMap((binding) => binding.keys)) {
			const { input, panel } = createSheetFixture();
			expect(panel.onKey?.({ name: keyName }, input)).toBe(true);
		}
	});

	test.each(["initiative", "roll setup"] as const)(
		"nominates every key claimed in the %s fixture",
		(mode) => {
			const nominations = nominatedKeys(panelAt(0));
			for (const keyName of CANONICAL_KEY_NAMES) {
				const { input, panel } = createInitiativeFixture(mode);
				const claimed = panel.onKey?.({ name: keyName }, input) ?? false;
				if (claimed) {
					expect(nominations).toContain(keyName);
				}
			}
		}
	);

	test("nominates every key claimed in the sheets fixture", () => {
		const nominations = nominatedKeys(panelAt(1));
		for (const keyName of CANONICAL_KEY_NAMES) {
			const { input, panel } = createSheetFixture();
			const claimed = panel.onKey?.({ name: keyName }, input) ?? false;
			if (claimed) {
				expect(nominations).toContain(keyName);
			}
		}
	});

	test("nominates no reserved Panel key", () => {
		for (const panel of view.createPanels()) {
			for (const keyName of nominatedKeys(panel)) {
				expect(RESERVED_PANEL_KEYS.has(keyName)).toBe(false);
			}
		}
	});
});
