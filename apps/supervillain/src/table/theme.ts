import { feedFormat, listIf } from "@supervillain/domain";
import type { FeedFormat } from "@supervillain/domain";

import type { Present } from "./view.ts";

export const color = {
	brand: "#e06c75",
	text: "#d0d0d0",
	bright: "#ffffff",
	dim: "#808080",
	border: "#5c6370",
	gm: "#e5c07b",
	you: "#98c379",
	dice: "#56b6c2",
	game: "#e5c07b",
	notice: "#e5c07b",
	debug: "#98c379",
	cursorFg: "#000000",
	cursorBg: "#d0d0d0",
	heroes: "#61afef",
	director: "#c678dd",
	healthy: "#98c379",
	winded: "#e5c07b",
	dying: "#ff5f5f",
	mineBg: "#3e4452",
	floor: "#5c6370",
	wall: "#8a8a8a",
	difficult: "#87875f",
	terrain: "#a8a8a8",
	reach: "#1f3d3d",
	heroesBody: "#1d3348",
	directorBody: "#3a2442",
	youBody: "#2c3a24",
	deadBody: "#2a2a2a",
	readAloud: "#d19a66",
	tierTable: "#98c379",
	tierCodex: "#61afef",
	tracker: "#56b6c2",
} as const;

export interface FeedStyle extends FeedFormat {
	readonly who: string;
	readonly text: string;
}

interface Colours {
	readonly who: string;
	readonly text: string;
}

const COLOURS = new Map<string, Colours>([
	["chat", { who: color.bright, text: color.text }],
	["emote", { who: color.bright, text: color.text }],
	["narration", { who: color.gm, text: color.gm }],
	["roll", { who: color.dice, text: color.dice }],
	["name", { who: color.dim, text: color.dim }],
]);

const GAME: Colours = { who: color.game, text: color.game };

export const feedStyle = (kind: string): FeedStyle => {
	const colours = COLOURS.get(kind) ?? GAME;

	return { ...feedFormat(kind), ...colours };
};

export const people = (
	present: ReadonlyArray<Present>
): ReadonlyArray<Present> => {
	const seen = new Set<string>();

	return present.filter((p) => {
		const fresh = !seen.has(p.actor);
		seen.add(p.actor);

		return fresh;
	});
};

export const personLabel = (p: Present, me: string): string => {
	const gm = p.gm && p.label !== "GM" ? " (GM)" : "";

	return `${p.label}${gm}${p.actor === me ? " (you)" : ""}`;
};

export const personColor = (p: Present, me: string): string => {
	if (p.gm) {
		return color.gm;
	}

	return p.actor === me ? color.you : color.text;
};

export interface FittedLabels {
	readonly shown: ReadonlyArray<number>;
	readonly more: number;
}

export const fitLabels = (
	labels: ReadonlyArray<string>,
	width: number,
	mine = -1
): FittedLabels => {
	const order = [
		...listIf(mine >= 0, () => [mine]),
		...[...labels.keys()].filter((i) => i !== mine),
	];

	const shown: Array<number> = [];
	let used = 0;

	for (const [n, i] of order.entries()) {
		const add = (shown.length > 0 ? 2 : 0) + Bun.stringWidth(labels[i] ?? "");
		const left = order.length - n - 1;
		const tail = left > 0 ? `, +${left}`.length : 0;

		if (used + add + tail > width) {
			break;
		}

		shown.push(i);
		used += add;
	}

	return {
		shown: shown.toSorted((a, b) => a - b),
		more: labels.length - shown.length,
	};
};
