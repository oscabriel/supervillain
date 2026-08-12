/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the runner is the runtime claim. */
import { describe, expect, test } from "bun:test";

import { RESERVED_PANEL_KEYS } from "@supervillain/core";
import type {
	GamePanel,
	GamePanelInput,
	MessageTask,
	TableView,
} from "@supervillain/core";

import { init } from "../src/model.js";
import type { FakeCommand, FakeState } from "../src/model.js";
import { view } from "../src/view.js";

/** The no-secret-keys probe alphabet: every `PanelKey.name` the Table chrome
 * can dispatch to a Panel. Kept byte-identical with the Draw Steel module's
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
	actor: "player-key",
	gmSeatId: "gm",
	seats: [
		{ actor: "gm-key", characterId: null, id: "gm" },
		{ actor: "player-key", characterId: null, id: "player" },
	],
};

const createFixture = (): {
	readonly input: GamePanelInput<FakeState, FakeCommand>;
	readonly panel: GamePanel<FakeState, FakeCommand>;
} => {
	const [panel] = view.createPanels();
	if (panel?.onKey === undefined || panel.keySurface === undefined) {
		throw new Error("interactive nominated visits panel missing");
	}
	const dispatches: FakeCommand[] = [];
	const tasks: MessageTask<FakeCommand>[] = [];
	return {
		input: {
			dispatch: (command) => dispatches.push(command),
			focused: true,
			requestMessageTask: (task) => tasks.push(task),
			state: init(),
			table,
		},
		panel,
	};
};

const nominatedKeys = (panel: GamePanel<FakeState, FakeCommand>): Set<string> =>
	new Set(
		(panel.keySurface ?? []).flatMap((group) =>
			group.bindings.flatMap((binding) => binding.keys)
		)
	);

describe("fake game Panel key-surface conformance", () => {
	test("claims every nominated visits key", () => {
		const sourcePanel = createFixture().panel;
		for (const keyName of nominatedKeys(sourcePanel)) {
			const { input, panel } = createFixture();
			expect(panel.onKey?.({ name: keyName }, input)).toBe(true);
		}
	});

	test("nominates every key claimed by the visits Panel", () => {
		const nominations = nominatedKeys(createFixture().panel);
		for (const keyName of CANONICAL_KEY_NAMES) {
			const { input, panel } = createFixture();
			const claimed = panel.onKey?.({ name: keyName }, input) ?? false;
			if (claimed) {
				expect(nominations).toContain(keyName);
			}
		}
	});

	test("nominates no reserved Panel key", () => {
		for (const keyName of nominatedKeys(createFixture().panel)) {
			expect(RESERVED_PANEL_KEYS.has(keyName)).toBe(false);
		}
	});
});
