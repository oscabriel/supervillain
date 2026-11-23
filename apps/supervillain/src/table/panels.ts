import { listIf } from "@supervillain/domain";

import type { Layout } from "./input.ts";

export const PANELS = ["band", "map", "feed", "reply", "prep"] as const;

export type Panel = (typeof PANELS)[number];

export interface Panels {
	readonly band: boolean;
	readonly map: boolean;
	readonly feed: boolean;
	readonly reply: boolean;
	readonly prep: boolean;
	readonly mapFirst: boolean;
}

export const ALL_SHOWN: Panels = {
	band: true,
	map: true,
	feed: true,
	reply: true,
	prep: false,
	mapFirst: false,
};

export const panelNumber = (panel: Panel): number => PANELS.indexOf(panel) + 1;

export const panelOf = (n: number): Panel | undefined => PANELS[n - 1];

export const panelsOf = (prep: boolean): ReadonlyArray<Panel> =>
	prep ? PANELS : PANELS.filter((p) => p !== "prep");

export const panelKeys = (prep: boolean): string =>
	`Alt+1-${panelsOf(prep).length}`;

const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

export const panelMark = (panel: Panel): string =>
	SUPERSCRIPT[panelNumber(panel)] ?? "";

export const marked = (title: string, mark: string | undefined): string =>
	mark === undefined || mark === "" ? title : ` ${mark} ${title.trimStart()}`;

export const fittedTitle = (
	titles: ReadonlyArray<string>,
	mark: string | undefined,
	width: number
): string => {
	const all = titles.map((t) => marked(t, mark));

	return all.find((t) => Bun.stringWidth(t) + 4 <= width) ?? all.at(-1) ?? "";
};

export const togglePanel = (
	p: Panels,
	panel: Panel,
	replyOpen: boolean
): Panels => {
	if (panel !== "map") {
		return { ...p, [panel]: !p[panel] };
	}

	const shown = p.map && !(replyOpen && p.reply);

	return shown
		? { ...p, map: false }
		: { ...p, map: true, reply: replyOpen ? false : p.reply };
};

export const viewPreset = (p: Panels, layout: Layout | "toggle"): Panels => {
	if (layout === "toggle") {
		return p.map ? { ...p, map: false } : { ...p, map: true, mapFirst: false };
	}

	const preset = { ...ALL_SHOWN, prep: p.prep };

	if (layout === "map") {
		return { ...preset, mapFirst: true };
	}

	return layout === "feed" ? { ...preset, map: false } : preset;
};

export interface PanelPiece {
	readonly text: string;
	readonly panel?: Panel;
}

export const allHiddenParts = (
	available: ReadonlyArray<Panel>,
	width: number,
	keysSaid: string = panelKeys(false)
): ReadonlyArray<PanelPiece> => {
	const keys = available.flatMap((p, i): Array<PanelPiece> => [
		...listIf(i > 0, () => [{ text: " · " }]),
		{ text: `Alt+${panelNumber(p)} ${p}`, panel: p },
	]);

	const lines: ReadonlyArray<ReadonlyArray<PanelPiece>> = [
		[
			{ text: "every panel is hidden · " },
			...keys,
			{ text: " · /view both shows them all" },
		],
		[{ text: "every panel is hidden · " }, ...keys],
		[{ text: `every panel is hidden · ${keysSaid} or /view both` }],
		[{ text: `panels hidden · ${keysSaid}` }],
	];

	const widthOf = (line: ReadonlyArray<PanelPiece>) =>
		Bun.stringWidth(line.map((p) => p.text).join(""));

	return lines.find((l) => widthOf(l) <= width) ?? lines.at(-1) ?? [];
};

export const hiddenPanels = (
	p: Panels,
	available: ReadonlyArray<Panel>
): ReadonlyArray<Panel> =>
	PANELS.filter((panel) => available.includes(panel) && !p[panel]);

export const shownAgainText = (panel: Panel): string =>
	`${panelMark(panel)} ${panel}`;
