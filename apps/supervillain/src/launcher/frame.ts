import type { RulesetName } from "@supervillain/domain";
import { Option } from "effect";

import {
	cut,
	field,
	fitRow,
	heading,
	hint,
	layoutStage,
	MIN_TABLE_COLS,
	MIN_TABLE_ROWS,
	renderFrame,
	words,
} from "../chrome/frame.ts";
import type { BodyCursor, BodyView, Row, Seg } from "../chrome/frame.ts";
import {
	enterPill,
	footerRow,
	gettingStarted,
	inlineInputField,
	NAV_HINTS,
	pickList,
	rulesetsField,
	rulesRow,
	sandboxBody,
	sessionBody,
	sessionLead,
	stepsRow,
	tablesBody,
} from "../chrome/panes.ts";
import type { SessionPanes, TablePanes } from "../chrome/panes.ts";
import { HANDLE_RULE } from "../relay/protocol.ts";
import { color } from "../table/theme.ts";
import type { Launching } from "./keys.ts";
import type { FoundCampaign } from "./scan.ts";
import { tableSlug } from "./wizard.ts";
import type { Wizard, WizardStep } from "./wizard.ts";

export interface LauncherScreen {
	readonly state: Launching;
	readonly campaigns: ReadonlyArray<FoundCampaign>;
	readonly home: string;
	readonly handle: string | undefined;
	readonly relay: string | undefined;
	readonly term: string;
	readonly now: number;
}

const RULE_TEXT = {
	"draw-steel": "Draw Steel",
	"set-world": "set.world",
	pf2e: "PF2e (ORC)",
	freeform: "freeform",
} satisfies Record<RulesetName, string>;

const ago = (date: Date, now: number): string => {
	const minutes = Math.round((now - date.getTime()) / 60_000);

	if (minutes < 60) {
		return minutes <= 1 ? "just now" : `${minutes} min ago`;
	}

	const hours = Math.round(minutes / 60);

	if (hours < 48) {
		return `${hours} h ago`;
	}

	return `${Math.round(hours / 24)} days ago`;
};

export const playedText = (found: FoundCampaign, now: number): string =>
	Option.match(found.lastPlayed, {
		onNone: () => "never played",
		onSome: (date) => `played ${ago(date, now)}`,
	});

const emptyTables = (screen: LauncherScreen, w: number): BodyView => ({
	rows: [
		heading("your tables", w),
		[
			{ text: "○ ", fg: color.dim },
			{ text: cut("no tables yet", w - 2), fg: color.text },
		],
		[],
		...words(`Tables live as plain folders in ${screen.home}.`, color.dim, w),
		[],
		enterPill("create a table"),
	],
});

const tableList = (
	screen: LauncherScreen,
	w: number,
	maxItems: number
): Array<Row> =>
	pickList(
		{
			title: "your tables",
			items: screen.campaigns.map((found) => ({
				name: found.name,
				badge: found.here ? "● here" : found.rules,
				lit: found.here,
			})),
			picked: screen.state.picked,
			editing: screen.state.editing,
			other: "+ create a new table…",
			otherEdited: false,
		},
		w,
		maxItems
	);

const joinText = (
	relay: string,
	handle: string | undefined,
	table: string
): string =>
	handle === undefined ? `relay · ${relay}` : `ssh ${handle}/${table}@${relay}`;

const tableDetail = (screen: LauncherScreen, w: number): BodyView => {
	const { state, campaigns, handle, relay, now } = screen;
	const current = campaigns[state.picked];

	if (state.editing) {
		const input = inlineInputField(
			"handle",
			state.typedHandle,
			"type your handle…",
			true,
			w
		);

		const rows: Array<Row> = [
			heading("your GM handle", w, color.bright),
			...words(
				"Players type it before your table's name: ssh <handle>/<table>@…",
				color.dim,
				w
			),
			[],
		];

		const inputRowIndex = rows.length;

		rows.push(
			input.row,
			field("format", [{ text: cut(HANDLE_RULE, w - 10), fg: color.dim }])
		);

		return {
			rows,
			cursor: { row: inputRowIndex, col: input.cursorCol },
		};
	}

	if (current !== undefined) {
		const modeLine: Row =
			relay === undefined
				? [{ text: "local only", fg: color.dim }]
				: [
						{
							text: cut(joinText(relay, handle, current.name), w - 10),
							fg: color.dice,
						},
					];

		return {
			rows: [
				heading(current.name, w, color.bright),
				[
					{ text: RULE_TEXT[current.rules], fg: color.heroes },
					{ text: ` · ${playedText(current, now)}`, fg: color.dim },
				],
				[],
				enterPill("open table"),
				[],
				field("mode", modeLine),
				field("folder", [
					{
						text: cut(
							current.here ? `${current.dir} (here)` : current.dir,
							w - 10
						),
						fg: color.dim,
					},
				]),
			],
		};
	}

	return {
		rows: [
			heading("create a new table", w, color.bright),
			...words(
				`Make a fresh campaign folder in ${screen.home} and sit straight down as GM.`,
				color.dim,
				w
			),
			[],
			enterPill("new table"),
		],
	};
};

const tablePanes = (screen: LauncherScreen): TablePanes => ({
	count: screen.campaigns.length,
	editing: screen.state.editing,
	empty: (w) => emptyTables(screen, w),
	started: (w) =>
		gettingStarted("Make a new campaign folder and open it as GM.", w),
	list: (w, maxItems) => tableList(screen, w, maxItems),
	detail: (w) => tableDetail(screen, w),
});

const tryBody = (w: number, cols: number, rows: number): BodyView =>
	sandboxBody(
		enterPill("start sandbox"),
		{
			cols: MIN_TABLE_COLS,
			rows: MIN_TABLE_ROWS,
			note: () => field("storage", [{ text: "memory only", fg: color.text }]),
		},
		w,
		cols,
		rows
	);

const wizardSteps = (
	wizard: Wizard
): ReadonlyArray<readonly [WizardStep, string]> => {
	const steps: Array<readonly [WizardStep, string]> = [
		["name", "name"],
		["rules", "rules"],
	];

	if (wizard.rules === "draw-steel") {
		steps.push(["example", "sample"]);
	}

	if (wizard.askHandle) {
		steps.push(["handle", "handle"]);
	}

	return steps;
};

const sampleRow = (example: boolean, choosing: boolean): Row => {
	if (!choosing) {
		return [
			{
				text: example
					? "yes · four heroes, the bandits and a map"
					: "no · empty campaign",
				fg: color.text,
			},
		];
	}

	return example
		? [
				{ text: "‹ yes ›", fg: color.bright, bold: true },
				{ text: "  no", fg: color.dim },
				{ text: "  · four heroes, bandits and a map", fg: color.dim },
			]
		: [
				{ text: "yes  ", fg: color.dim },
				{ text: "‹ no ›", fg: color.bright, bold: true },
				{ text: "  · empty campaign", fg: color.dim },
			];
};

const createBody = (screen: LauncherScreen, w: number): BodyView => {
	const { wizard, editing } = screen.state;
	const slug = tableSlug(wizard.name);

	const rows: Array<Row> = [
		stepsRow(wizardSteps(wizard), wizard.step, w),
		[
			{
				text: cut(`It goes in ${screen.home}/${slug || "<name>"}.`, w),
				fg: color.dim,
			},
		],
		[],
	];

	let cursor: BodyCursor | undefined;

	const nameEditing = editing && wizard.step === "name";

	const nameValue =
		wizard.name === "" || nameEditing
			? wizard.name
			: `${wizard.name}  (${slug || "?"})`;

	const nameField = inlineInputField(
		"name",
		nameValue,
		"Ford Road",
		nameEditing,
		w
	);

	if (nameEditing) {
		cursor = { row: rows.length, col: nameField.cursorCol };
	}

	rows.push(
		nameField.row,
		fitRow(field("rules", rulesRow(wizard.rules, wizard.step === "rules")), w)
	);

	if (wizard.rules === "draw-steel") {
		rows.push(
			fitRow(
				field("sample", sampleRow(wizard.example, wizard.step === "example")),
				w
			)
		);
	}

	if (wizard.askHandle) {
		const handleEditing = editing && wizard.step === "handle";

		const handleField = inlineInputField(
			"handle",
			wizard.handle,
			"your GM handle…",
			handleEditing,
			w
		);

		if (handleEditing) {
			cursor = { row: rows.length, col: handleField.cursorCol };
		}

		rows.push(handleField.row);
	}

	if (!editing) {
		rows.push([], enterPill("new table"));
	}

	return { rows, cursor };
};

const sessionPanes = (
	screen: LauncherScreen,
	cols: number,
	rows: number
): SessionPanes => ({
	left: (colW) => [
		...sessionLead(
			{
				term: screen.term,
				tableCount: screen.campaigns.length,
				tablesAre: "found",
			},
			colW,
			cols,
			rows
		),
		field("mode", [
			{
				text: screen.relay === undefined ? "local only" : "relay",
				fg: screen.relay === undefined ? color.gm : color.heroes,
			},
		]),
		field("handle", [
			{
				text: cut(screen.handle ?? "not set", colW - 10),
				fg: screen.handle === undefined ? color.dim : color.bright,
			},
		]),
	],
	right: (colW) => [
		heading("workspace", colW),
		field("home", [{ text: cut(screen.home, colW - 10), fg: color.text }]),
		field("relay", [
			{
				text: cut(screen.relay ?? "none (--local)", colW - 10),
				fg: screen.relay === undefined ? color.dim : color.dice,
			},
		]),
		[],
		heading("commands", colW),
		field("host", [
			{ text: cut("supervillain host <dir>", colW - 10), fg: color.director },
		]),
		field("mcp", [
			{ text: cut("supervillain mcp <dir>", colW - 10), fg: color.dice },
		]),
		rulesetsField(colW),
	],
});

const footerParts = (screen: LauncherScreen): ReadonlyArray<Array<Seg>> => {
	const { state, campaigns } = screen;

	if (state.tab === "try") {
		return [hint("enter", "start sandbox"), ...NAV_HINTS];
	}

	if (state.tab === "session") {
		return NAV_HINTS;
	}

	if (state.tab === "create") {
		if (!state.editing) {
			return [hint("enter", "start"), ...NAV_HINTS];
		}

		return state.wizard.step === "rules" || state.wizard.step === "example"
			? [
					hint("←/→", "change"),
					hint("enter", "next"),
					hint("esc", "back"),
					hint("ctrl-c", "quit"),
				]
			: [hint("enter", "next"), hint("esc", "back"), hint("ctrl-c", "quit")];
	}

	if (state.editing) {
		return [
			hint("enter", "open"),
			hint("esc", "cancel"),
			hint("ctrl-c", "quit"),
		];
	}

	if (campaigns.length === 0) {
		return [hint("enter", "new table"), ...NAV_HINTS];
	}

	return [
		hint("↑/↓", "pick"),
		hint("enter", state.picked >= campaigns.length ? "new table" : "open"),
		hint("n", "new"),
		hint("1-4", "tabs"),
		hint("q", "quit"),
	];
};

export const launcherFrame = (
	screen: LauncherScreen,
	cols: number,
	rows: number
): string => {
	const { state } = screen;

	return renderFrame(
		layoutStage({
			active: state.tab,
			editing: state.editing,
			tableCount: screen.campaigns.length,
			subtitle: screen.relay ?? "local only",
			cols,
			rows,
			bodies: {
				tables: (w) => tablesBody(tablePanes(screen), w, rows),
				try: (w) => tryBody(w, cols, rows),
				create: (w) => createBody(screen, w),
				session: (w) => sessionBody(sessionPanes(screen, cols, rows), w),
			},
			footer: (w) => footerRow(footerParts(screen), state.editing, "back", w),
			said: state.tab === "create" ? state.wizard.said : state.said,
		})
	);
};
