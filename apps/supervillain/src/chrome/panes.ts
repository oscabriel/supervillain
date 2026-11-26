import { RULESET_NAMES } from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";

import { color } from "../table/theme.ts";
import {
	BODY_ROWS,
	centred,
	columnGap,
	cut,
	field,
	fitRow,
	fitsTable,
	heading,
	hint,
	joinHints,
	pad,
	rowWidth,
	RULE,
	twoColumns,
	WIDE_SPLIT,
	width,
	windowText,
	words,
} from "./frame.ts";
import type { BodyView, Row, Seg } from "./frame.ts";

export interface InputRow {
	readonly row: Row;
	readonly cursorCol: number;
}

export interface PickItem {
	readonly name: string;
	readonly badge: string;
	readonly lit: boolean;
}

export interface PickList {
	readonly title: string;
	readonly items: ReadonlyArray<PickItem>;
	readonly picked: number;
	readonly editing: boolean;
	readonly other: string;
	readonly otherEdited: boolean;
}

export interface TablePanes {
	readonly count: number;
	readonly editing: boolean;
	readonly empty: (w: number) => BodyView;
	readonly started: (w: number) => Array<Row>;
	readonly list: (w: number, maxItems: number) => Array<Row>;
	readonly detail: (w: number) => BodyView;
}

export interface SandboxNeeds {
	readonly cols: number;
	readonly rows: number;
	readonly note: (colW: number) => Row;
}

export interface SessionFacts {
	readonly term: string;
	readonly tableCount: number;
	readonly tablesAre: string;
}

export interface SessionPanes {
	readonly left: (colW: number) => Array<Row>;
	readonly right: (colW: number, wide: boolean) => Array<Row>;
}

export const enterPill = (label: string): Row => [
	{ text: ` ${label} `, fg: color.cursorFg, bg: color.brand, bold: true },
	{ text: "  enter", fg: color.dim },
];

export const rulesRow = (rules: RulesetName, choosing: boolean): Row => {
	if (!choosing) {
		return [{ text: rules, fg: color.text }];
	}

	return RULESET_NAMES.flatMap((name, i): Row => {
		const gap: Row = i === 0 ? [] : [{ text: "  " }];

		return name === rules
			? [...gap, { text: `‹ ${name} ›`, fg: color.bright, bold: true }]
			: [...gap, { text: name, fg: color.dim }];
	});
};

const RULESET_LABELS: ReadonlyMap<string, string> = new Map([
	["set-world", "set.world"],
]);

const shownRuleset = (name: string): string => RULESET_LABELS.get(name) ?? name;

export const rulesetsField = (colW: number): Row =>
	field("rules", [
		{
			text: cut(RULESET_NAMES.map(shownRuleset).join(" · "), colW - 10),
			fg: color.text,
		},
	]);

export const inlineInputField = (
	label: string,
	value: string,
	placeholder: string,
	editing: boolean,
	w: number
): InputRow => {
	const valueW = Math.max(4, w - 12);
	const shown = cut(value, valueW);

	if (editing) {
		const display: Array<Seg> =
			value === ""
				? [{ text: cut(placeholder, valueW), fg: color.dim }]
				: [{ text: shown, fg: color.bright, bold: true }];

		return {
			row: field(label, [
				{ text: "› ", fg: color.brand, bold: true },
				...display,
			]),
			cursorCol: 12 + width(shown),
		};
	}

	const display: Array<Seg> =
		value === ""
			? [{ text: "…", fg: color.dim }]
			: [
					{ text: shown, fg: color.bright, bold: true },
					{ text: "   e to edit", fg: color.dim },
				];

	return {
		row: fitRow(field(label, display), w),
		cursorCol: 0,
	};
};

export const stepsRow = <Step extends string>(
	steps: ReadonlyArray<readonly [Step, string]>,
	current: Step,
	w: number
): Row =>
	fitRow(
		steps.flatMap(([step, label], i): Row => {
			const on = step === current;
			const sep: Row = i === 0 ? [] : [{ text: "  /  ", fg: RULE }];

			return [
				...sep,
				{ text: label, fg: on ? color.bright : color.dim, bold: on },
			];
		}),
		w
	);

const startedStep = (
	key: string,
	title: string,
	pitch: string,
	w: number
): Array<Row> => [
	[
		{ text: `${key}  `, fg: color.bright, bold: true },
		{ text: title, fg: color.bright, bold: true },
	],
	...words(pitch, color.dim, Math.max(8, w - 3)).map((r): Row => [
		{ text: "   " },
		...r,
	]),
];

export const gettingStarted = (createPitch: string, w: number): Array<Row> => [
	heading("getting started", w),
	...startedStep(
		"2",
		"Try a Table",
		"Play a solo Draw Steel encounter right here. Nothing is saved.",
		w
	),
	[],
	...startedStep("3", "Create a Table", createPitch, w),
];

const pickRow = (item: PickItem, on: boolean, w: number): Row => {
	const nameW = Math.max(4, w - 4 - width(item.badge));
	const name = pad(cut(item.name, nameW), nameW);

	if (on) {
		return [
			{
				text: ` ${name}  ${item.badge} `,
				fg: color.cursorFg,
				bg: color.brand,
				bold: true,
			},
		];
	}

	return [
		{ text: ` ${name}  `, fg: color.text },
		{ text: `${item.badge} `, fg: item.lit ? color.healthy : color.dim },
	];
};

const otherRow = (list: PickList, w: number): Row => {
	const labelW = Math.max(4, w - 2);
	const text = ` ${pad(cut(list.other, labelW), labelW)} `;

	if (list.picked === list.items.length && !list.editing) {
		return [{ text, fg: color.cursorFg, bg: color.brand, bold: true }];
	}

	return list.otherEdited
		? [{ text, fg: color.bright, bg: color.mineBg, bold: true }]
		: [{ text, fg: color.dim }];
};

export const pickList = (
	list: PickList,
	w: number,
	maxItems: number
): Array<Row> => {
	const { items, picked, editing } = list;
	const shown = Math.min(items.length, Math.max(1, maxItems));
	const clampedPick = Math.min(picked, items.length - 1);

	const start = Math.max(
		0,
		Math.min(clampedPick - Math.floor(shown / 2), items.length - shown)
	);

	const rows: Array<Row> = [heading(list.title, w)];

	for (const [offset, item] of items.slice(start, start + shown).entries()) {
		rows.push(pickRow(item, start + offset === picked && !editing, w));
	}

	if (items.length > shown) {
		const below = items.length - (start + shown);
		const parts: Array<string> = [];

		if (start > 0) {
			parts.push(`↑${start}`);
		}

		if (below > 0) {
			parts.push(`↓${below}`);
		}

		rows.push([{ text: ` ${parts.join("  ")}`, fg: color.dim }]);
	}

	rows.push([], otherRow(list, w));

	return rows;
};

export const tablesBody = (
	panes: TablePanes,
	w: number,
	rows: number
): BodyView => {
	const { count } = panes;

	const maxList = Math.max(
		4,
		Math.min(count, Math.max(BODY_ROWS - 3, rows - 16))
	);

	if (w < WIDE_SPLIT) {
		if (count === 0) {
			return panes.empty(w);
		}

		return panes.editing ? panes.detail(w) : { rows: panes.list(w, maxList) };
	}

	const gap = columnGap(w);
	const leftW = Math.floor((w - gap) * 0.45);
	const rightW = w - gap - leftW;

	if (count === 0) {
		const left = panes.empty(leftW);

		return {
			rows: twoColumns(left.rows, panes.started(rightW), leftW, gap),
			cursor: left.cursor,
		};
	}

	const right = panes.detail(rightW);

	return {
		rows: twoColumns(panes.list(leftW, maxList), right.rows, leftW, gap),
		cursor:
			right.cursor === undefined
				? undefined
				: { row: right.cursor.row, col: leftW + gap + right.cursor.col },
	};
};

const sandboxPitch = (action: Row, colW: number): Array<Row> => [
	[
		{ text: "◆ ", fg: color.brand },
		{
			text: cut("Solo Draw Steel sandbox", colW - 2),
			fg: color.bright,
			bold: true,
		},
	],
	[],
	...words(
		"Play the sample encounter as GM: Brann and Ilsa on the Ford Road against the bandits. Roll, move tokens, and run the fight.",
		color.text,
		colW
	),
	[],
	...words(
		"Nothing is saved: the table lives in memory and vanishes when you leave.",
		color.dim,
		colW
	),
	[],
	action,
];

const sandboxDetails = (
	needs: SandboxNeeds,
	colW: number,
	cols: number,
	rows: number
): Array<Row> => {
	const sizeMark: Seg =
		cols >= needs.cols && rows >= needs.rows
			? { text: ` ✓ ${cols}×${rows}`, fg: color.healthy }
			: { text: ` ! ${cols}×${rows}`, fg: color.notice };

	return [
		heading("details", colW),
		field("ruleset", [{ text: "draw-steel", fg: color.text }]),
		fitRow(
			field("window", [
				{ text: `${needs.cols}×${needs.rows}+`, fg: color.text },
				sizeMark,
			]),
			colW
		),
		needs.note(colW),
		field("help", [{ text: "/help inside the table", fg: color.dim }]),
	];
};

export const sandboxBody = (
	action: Row,
	needs: SandboxNeeds | undefined,
	w: number,
	cols: number,
	rows: number
): BodyView => {
	if (needs === undefined) {
		return { rows: sandboxPitch(action, w) };
	}

	if (w < WIDE_SPLIT) {
		return {
			rows: [
				...sandboxPitch(action, w),
				[],
				...sandboxDetails(needs, w, cols, rows),
			],
		};
	}

	const gap = columnGap(w);
	const leftW = Math.floor((w - gap) * 0.56);
	const rightW = w - gap - leftW;

	return {
		rows: twoColumns(
			sandboxPitch(action, leftW),
			sandboxDetails(needs, rightW, cols, rows),
			leftW,
			gap
		),
	};
};

export const sessionLead = (
	facts: SessionFacts,
	colW: number,
	cols: number,
	rows: number
): Array<Row> => [
	heading("session", colW),
	field("terminal", [{ text: cut(facts.term, colW - 10), fg: color.text }]),
	field("window", [
		{
			text: cut(windowText(cols, rows), colW - 10),
			fg: fitsTable(cols, rows) ? color.text : color.notice,
		},
	]),
	field("tables", [
		{
			text: `${facts.tableCount} ${facts.tablesAre}`,
			fg: facts.tableCount > 0 ? color.healthy : color.dim,
		},
	]),
];

export const sessionBody = (panes: SessionPanes, w: number): BodyView => {
	if (w < WIDE_SPLIT) {
		return { rows: [...panes.left(w), [], ...panes.right(w, false)] };
	}

	const gap = columnGap(w);
	const rightW = Math.min(54, Math.max(50, Math.floor((w - gap) * 0.62)));
	const leftW = w - gap - rightW;

	return {
		rows: twoColumns(panes.left(leftW), panes.right(rightW, true), leftW, gap),
	};
};

export const NAV_HINTS: ReadonlyArray<Array<Seg>> = [
	hint("1-4", "tabs"),
	hint("tab", "next"),
	hint("q", "quit"),
];

export const footerRow = (
	parts: ReadonlyArray<Array<Seg>>,
	editing: boolean,
	escape: string,
	w: number
): Row => {
	const full = joinHints(parts);

	if (rowWidth(full) <= w) {
		return centred(full, w);
	}

	const compact = editing
		? joinHints([
				hint("enter", "ok"),
				hint("esc", escape),
				hint("ctrl-c", "quit"),
			])
		: joinHints([hint("1-4", "tabs"), hint("q", "quit")]);

	return centred(fitRow(compact, w), w);
};
