import type { FeedLine, TextRun } from "@supervillain/core";

export interface RuleConnections {
	readonly down?: boolean;
	readonly left?: boolean;
	readonly right?: boolean;
	readonly up?: boolean;
}

const JUNCTIONS: Readonly<Record<string, string>> = {
	"0011": "┐",
	"0101": "─",
	"0110": "┌",
	"0111": "┬",
	"1001": "┘",
	"1010": "│",
	"1011": "┤",
	"1100": "└",
	"1101": "┴",
	"1110": "├",
	"1111": "┼",
};

/** Computes the one light-box glyph for a set of meeting rule directions. */
export const ruleJunction = (connections: RuleConnections): string => {
	const key = [
		connections.up === true ? "1" : "0",
		connections.right === true ? "1" : "0",
		connections.down === true ? "1" : "0",
		connections.left === true ? "1" : "0",
	].join("");
	const glyph = JUNCTIONS[key];
	if (glyph === undefined) {
		throw new Error("A rule junction needs at least two connections.");
	}
	return glyph;
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ELLIPSIS = "…";
const HEADER_DECORATION_WIDTH = 5;

/** Table is Bun-bound, but its production tsconfig deliberately exposes only
 * Node compatibility types. Keep the one Bun width primitive local. */
const displayWidth = (
	globalThis as typeof globalThis & {
		readonly Bun: { readonly stringWidth: (text: string) => number };
	}
).Bun.stringWidth;

const normalizeWidth = (width: number): number =>
	Math.max(0, Math.floor(width));

const singleLine = (text: string): string =>
	text.replaceAll(/\s+/gu, " ").trim();

/** Clips a label by terminal cells and only at grapheme boundaries. */
const clipLabel = (text: string, width: number): string => {
	const normalized = singleLine(text);
	if (displayWidth(normalized) <= width) {
		return normalized;
	}
	if (width < 1) {
		return "";
	}
	const contentWidth = width - displayWidth(ELLIPSIS);
	let clipped = "";
	let used = 0;
	for (const { segment } of GRAPHEMES.segment(normalized)) {
		const segmentWidth = displayWidth(segment);
		if (used + segmentWidth > contentWidth) {
			break;
		}
		clipped += segment;
		used += segmentWidth;
	}
	return `${clipped}${ELLIPSIS}`;
};

const ruleRun = (text: string): TextRun => ({
	attrs: ["dim"],
	text,
	token: "muted",
});

/** Formats one exact-width label-in-rule header. At tiny widths ornament
 * demotes to an unbroken rule instead of emitting clipped bracket fragments. */
export const ruleHeader = (label: string, width: number): FeedLine => {
	const cells = normalizeWidth(width);
	const labelWidth = cells - HEADER_DECORATION_WIDTH;
	const clipped = clipLabel(label, labelWidth);
	if (clipped === "" || clipped === ELLIPSIS) {
		return { runs: cells === 0 ? [] : [ruleRun("─".repeat(cells))] };
	}
	const fill = cells - HEADER_DECORATION_WIDTH - displayWidth(clipped);
	return {
		runs: [
			ruleRun("─┤ "),
			{ attrs: ["bold"], text: clipped, token: "primary" },
			ruleRun(` ├${"─".repeat(fill)}`),
		],
	};
};

export interface BandHeaderInput {
	readonly leftLabel: string;
	readonly rightLabel: string;
	readonly rightWidth: number;
	readonly vertical: "down" | "up";
	readonly width: number;
}

/** Composes the full-width header over the center/sidebar split. The meeting
 * glyph is computed from the actual vertical continuation, never hand-picked. */
export const bandHeader = (input: BandHeaderInput): FeedLine => {
	const width = normalizeWidth(input.width);
	if (width < 3) {
		return ruleHeader(input.leftLabel, width);
	}
	const rightWidth = Math.min(
		Math.max(1, normalizeWidth(input.rightWidth)),
		width - 2
	);
	const leftWidth = width - rightWidth - 1;
	const junction = ruleJunction({
		down: input.vertical === "down",
		left: true,
		right: true,
		up: input.vertical === "up",
	});
	return {
		runs: [
			...ruleHeader(input.leftLabel, leftWidth).runs,
			ruleRun(junction),
			...ruleHeader(input.rightLabel, rightWidth).runs,
		],
	};
};

/** Draws the sidebar's single-side rule. Rows carrying a center-region header
 * become computed left-facing junctions; all other rows remain vertical. */
export const verticalBandDivider = (
	height: number,
	junctionRows: readonly number[]
): string => {
	const rows = normalizeWidth(height);
	const meetings = new Set(junctionRows);
	const junction = ruleJunction({ down: true, left: true, up: true });
	return Array.from({ length: rows }, (_, row) =>
		meetings.has(row) ? junction : "│"
	).join("\n");
};
