import { LinearScrollAccel, MouseButton } from "@opentui/core";
import type {
	BoxRenderable,
	MouseEvent,
	ScrollAcceleration,
} from "@opentui/core";
import { actionLine } from "@supervillain/domain";

import type { TokenAction } from "./view.ts";

export interface Clicked {
	readonly token?: { readonly id: string; readonly mark: string | undefined };
	readonly square?: string;
}

export interface Selection {
	readonly id: string;
	readonly chosen?: TokenAction;
	readonly picked: ReadonlyArray<string>;
}

export type ClickResult =
	| { readonly kind: "select"; readonly id: string }
	| { readonly kind: "clear" }
	| { readonly kind: "send"; readonly line: string }
	| { readonly kind: "picked"; readonly picked: ReadonlyArray<string> }
	| { readonly kind: "insert"; readonly text: string }
	| { readonly kind: "none" };

const chosenOutcome = (
	selection: Selection,
	chosen: TokenAction,
	click: Clicked
): ClickResult => {
	const { token, square } = click;

	if (chosen.pick === "square") {
		return square === undefined
			? { kind: "none" }
			: { kind: "send", line: actionLine(chosen, [square]) };
	}

	if (chosen.pick === "none" || token === undefined) {
		return { kind: "none" };
	}

	if (chosen.pick === "target") {
		return { kind: "send", line: actionLine(chosen, [token.id]) };
	}

	const has = selection.picked.includes(token.id);

	return {
		kind: "picked",
		picked: has
			? selection.picked.filter((p) => p !== token.id)
			: [...selection.picked, token.id],
	};
};

export const clickOutcome = (
	selection: Selection | undefined,
	click: Clicked,
	mayAct: (id: string) => boolean
): ClickResult => {
	const { token, square } = click;
	const chosen = selection?.chosen;

	if (selection !== undefined && chosen !== undefined) {
		return chosenOutcome(selection, chosen, click);
	}

	if (token !== undefined && mayAct(token.id)) {
		return token.id === selection?.id
			? { kind: "clear" }
			: { kind: "select", id: token.id };
	}

	if (selection !== undefined) {
		return { kind: "clear" };
	}

	const text = token === undefined ? square : (token.mark ?? token.id);

	return text === undefined ? { kind: "none" } : { kind: "insert", text };
};

export const menuStands = (
	selection: Selection,
	actions: ReadonlyArray<TokenAction> | undefined
): boolean => {
	if (actions === undefined) {
		return false;
	}

	const { chosen } = selection;

	return (
		chosen === undefined ||
		actions.some(
			(a) =>
				a.label === chosen.label &&
				a.pick === chosen.pick &&
				a.line === chosen.line
		)
	);
};

export const choose = (
	selection: Selection,
	action: TokenAction
):
	| { readonly kind: "send"; readonly line: string }
	| { readonly kind: "chosen"; readonly selection: Selection } =>
	action.pick === "none"
		? { kind: "send", line: action.line }
		: {
				kind: "chosen",
				selection: { id: selection.id, chosen: action, picked: [] },
			};

export interface Menu {
	readonly lead: string;
	readonly items: ReadonlyArray<MenuItem>;
}

export type MenuItem =
	| {
			readonly kind: "action";
			readonly label: string;
			readonly action: TokenAction;
	  }
	| { readonly kind: "roll"; readonly label: string; readonly line: string }
	| { readonly kind: "cancel"; readonly label: string };

const CANCEL: MenuItem = { kind: "cancel", label: "Cancel" };

export const menuOf = (
	selection: Selection,
	actions: ReadonlyArray<TokenAction>,
	name: (id: string) => string,
	mark: (id: string) => string
): Menu => {
	const who = name(selection.id);
	const { chosen } = selection;

	if (chosen === undefined) {
		return {
			lead: `${who}:`,
			items: [
				...actions.map((a): MenuItem => ({
					kind: "action",
					label: a.label,
					action: a,
				})),
				CANCEL,
			],
		};
	}

	const head = `${who} · ${chosen.label}:`;

	if (chosen.pick === "square") {
		return { lead: `${head} click a square`, items: [CANCEL] };
	}

	if (chosen.pick === "target") {
		return { lead: `${head} click a target`, items: [CANCEL] };
	}

	const on = selection.picked.map(mark).join(" ");

	return {
		lead: on === "" ? `${head} click targets, then Roll` : `${head} on ${on}`,
		items: [
			{
				kind: "roll",
				label: "Roll",
				line: actionLine(chosen, selection.picked),
			},
			CANCEL,
		],
	};
};

export interface MenuPiece {
	readonly text: string;
	readonly item?: number;
}

export const itemText = (label: string): string => ` ${label} `;

export const menuRows = (
	menu: Menu,
	width: number
): ReadonlyArray<ReadonlyArray<MenuPiece>> => {
	let row: Array<MenuPiece> = [{ text: menu.lead }];
	const rows: Array<Array<MenuPiece>> = [row];
	let used = Bun.stringWidth(menu.lead);

	for (const [i, item] of menu.items.entries()) {
		const text = itemText(item.label);
		const w = Bun.stringWidth(text);

		if (used > 0 && used + 1 + w > width) {
			row = [{ text, item: i }];
			rows.push(row);
			used = w;
			continue;
		}

		if (used > 0) {
			row.push({ text: " " });
		}

		row.push({ text, item: i });
		used += (used > 0 ? 1 : 0) + w;
	}

	return rows;
};

const TITLE_AT = 2;

export const onTitle = (
	title: string,
	boxWidth: number,
	col: number
): boolean => {
	const w = Bun.stringWidth(title);

	return w > 0 && w + 4 <= boxWidth && col >= TITLE_AT && col < TITLE_AT + w;
};

export const isLeftButton = (event: MouseEvent): boolean =>
	MouseButton[event.button] === "LEFT";

export const boxClick =
	(
		box: () => BoxRenderable | undefined,
		title: () => string,
		onTitleClick: (() => void) | undefined,
		inside?: (col: number, row: number) => void
	) =>
	(event: MouseEvent): void => {
		const b = box();

		if (!isLeftButton(event) || b === undefined) {
			return;
		}

		const col = event.x - b.x;
		const row = event.y - b.y;

		if (row === 0) {
			if (onTitle(title(), b.width, col)) {
				onTitleClick?.();
			}

			return;
		}

		inside?.(col, row);
	};

export const WHEEL_LINES = 3;

const linear = new LinearScrollAccel();

export const wheel: ScrollAcceleration = {
	tick: () => WHEEL_LINES * linear.tick(),
	reset: () => {
		linear.reset();
	},
};
