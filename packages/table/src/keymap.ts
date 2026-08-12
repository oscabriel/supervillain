import { RESERVED_PANEL_KEYS } from "@supervillain/core";
import type { PanelKeyBinding, PanelKeyGroup } from "@supervillain/core";

export type TablePane = "feed" | "map" | "message" | "sidebar";

export type KeybindingScope =
	| "core"
	| "message"
	| "feed"
	| "map"
	| "sidebar"
	| "key-sheet";

export interface TableKeybinding {
	readonly keys: string;
	readonly display?: string;
	readonly label: string;
	readonly scope: KeybindingScope;
	readonly bar: "permanent" | "contextual" | "none";
}

/** ADR-0030's core Table key surface. The compact bar and expanded sheet
 * select from this value; neither owns hand-written key help. */
export const TABLE_KEYBINDINGS: readonly TableKeybinding[] = [
	{ bar: "permanent", keys: "tab", label: "pane", scope: "core" },
	{ bar: "permanent", keys: "v", label: "layout", scope: "core" },
	{ bar: "permanent", keys: "?", label: "keys", scope: "core" },
	{ bar: "none", keys: "shift+tab", label: "previous pane", scope: "core" },
	{
		bar: "contextual",
		keys: "enter",
		label: "send / submit",
		scope: "message",
	},
	{
		bar: "contextual",
		keys: "esc",
		label: "return / cancel",
		scope: "message",
	},
	{ bar: "none", keys: "tab", label: "pane · keep draft", scope: "message" },
	{ bar: "none", keys: "printable", label: "text", scope: "message" },
	{ bar: "contextual", keys: "↑↓/jk", label: "line", scope: "feed" },
	{ bar: "contextual", keys: "pgup/pgdn", label: "page", scope: "feed" },
	{ bar: "none", keys: "home/end", label: "oldest / latest", scope: "feed" },
	{ bar: "none", keys: "c", label: "rail", scope: "feed" },
	{ bar: "contextual", keys: "arrows/hjkl", label: "move", scope: "map" },
	{
		bar: "contextual",
		keys: "enter/space",
		label: "hold / drop",
		scope: "map",
	},
	{ bar: "none", keys: "x/delete", label: "remove", scope: "map" },
	{ bar: "none", keys: "t", label: "map tier", scope: "map" },
	{ bar: "contextual", keys: "←/→", label: "panel", scope: "sidebar" },
	{ bar: "contextual", keys: "c", label: "rail", scope: "sidebar" },
	{ bar: "none", keys: "↑/↓", label: "active panel", scope: "sidebar" },
	{ bar: "none", keys: "f", label: "focus marker", scope: "key-sheet" },
	{ bar: "none", keys: "t", label: "map tier", scope: "key-sheet" },
	{ bar: "none", keys: "?/esc", label: "close", scope: "key-sheet" },
] as const;

export interface KeybindBarEntry extends TableKeybinding {
	readonly disabled: boolean;
}

export interface KeybindBar {
	readonly compact: boolean;
	readonly entries: readonly KeybindBarEntry[];
	readonly pane: TablePane;
}

export const formatBinding = (
	binding: Pick<TableKeybinding, "display" | "keys" | "label">
): string => `[${binding.display ?? binding.keys}] ${binding.label}`;

const EXPANDED_KEYBIND_BAR_ENTRIES = 5;
const COMPACT_KEYBIND_BAR_ENTRIES = 3;

const entriesForBar = (
	pane: TablePane,
	messageOwnsText: boolean,
	contextual: boolean
): readonly KeybindBarEntry[] =>
	TABLE_KEYBINDINGS.filter(
		(binding) =>
			binding.bar === "permanent" ||
			(contextual && binding.bar === "contextual" && binding.scope === pane)
	)
		.slice(
			0,
			contextual ? EXPANDED_KEYBIND_BAR_ENTRIES : COMPACT_KEYBIND_BAR_ENTRIES
		)
		.map((binding) => ({
			...binding,
			disabled:
				messageOwnsText && binding.scope === "core" && binding.keys !== "tab",
		}));

export const keybindBarText = (bar: KeybindBar): string =>
	`${bar.pane}  ${bar.entries.map(formatBinding).join("  ")}`;

/** Selects five entries only when the complete string fits, otherwise the
 * first demotion stage preserves the three permanent entries. */
export const deriveKeybindBar = (
	pane: TablePane,
	messageOwnsText: boolean,
	availableWidth: number
): KeybindBar => {
	const expanded: KeybindBar = {
		compact: false,
		entries: entriesForBar(pane, messageOwnsText, true),
		pane,
	};
	if (keybindBarText(expanded).length <= availableWidth) {
		return expanded;
	}
	return {
		compact: true,
		entries: entriesForBar(pane, messageOwnsText, false),
		pane,
	};
};

const SHEET_SCOPES: Readonly<Record<TablePane, readonly KeybindingScope[]>> = {
	feed: ["core", "feed", "key-sheet"],
	map: ["core", "map", "key-sheet"],
	message: ["message", "key-sheet"],
	sidebar: ["core", "sidebar", "key-sheet"],
};

const SCOPE_LABEL: Readonly<Record<KeybindingScope, string>> = {
	core: "table",
	feed: "feed",
	"key-sheet": "key sheet",
	map: "map",
	message: "message",
	sidebar: "sidebar chrome",
};

interface PanelKeySurface {
	readonly id: string;
	readonly keySurface?: readonly PanelKeyGroup[];
}

const formatPanelBinding = (binding: PanelKeyBinding): string =>
	`[${binding.display ?? binding.keys.join("/")}] ${binding.label}`;

const formatPanelKeyGroup = (panelId: string, group: PanelKeyGroup): string => {
	const bindings: string[] = [];
	const warnings: string[] = [];
	for (const binding of group.bindings) {
		const offendingKeys = binding.keys.filter((key) =>
			RESERVED_PANEL_KEYS.has(key)
		);
		if (offendingKeys.length > 0) {
			warnings.push(
				`! panel ${panelId} nominated reserved ${offendingKeys.join("/")}; binding skipped`
			);
			continue;
		}
		bindings.push(formatPanelBinding(binding));
	}
	return [
		group.title,
		...(bindings.length === 0 ? [] : [`  ${bindings.join("  ")}`]),
		...warnings.map((warning) => `  ${warning}`),
	].join("\n");
};

/** The expanded focused-Pane sheet. Core/chrome groups come from the binding
 * source shared with the bar; ADR-0031 appends only the active Sidebar Panel's
 * strings-only nominations. */
export const deriveKeySheet = (
	pane: TablePane,
	activePanel?: PanelKeySurface
): string => {
	const chromeGroups = SHEET_SCOPES[pane].map((scope) => {
		const bindings = TABLE_KEYBINDINGS.filter(
			(binding) => binding.scope === scope
		).map(formatBinding);
		return `${SCOPE_LABEL[scope]}\n  ${bindings.join("  ")}`;
	});
	const panelGroups =
		pane === "sidebar" && activePanel !== undefined
			? (activePanel.keySurface ?? []).map((group) =>
					formatPanelKeyGroup(activePanel.id, group)
				)
			: [];
	return [...chromeGroups, ...panelGroups].join("\n\n");
};
