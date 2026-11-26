import { charsOf } from "@supervillain/domain";

import type { Prose, ProseBlock } from "./view.ts";

export type ProseTone = "text" | "heading" | "quote" | "pre" | "list";

export interface ProseLine {
	readonly text: string;
	readonly tone: ProseTone;
}

const SPACE = /\s+/u;

export const clip = (text: string, width: number): string => {
	if (Bun.stringWidth(text) <= width) {
		return text;
	}

	let out = "";

	for (const ch of charsOf(text)) {
		if (Bun.stringWidth(out + ch) > width) {
			break;
		}

		out += ch;
	}

	return out;
};

const pieces = (word: string, width: number): ReadonlyArray<string> => {
	const out: Array<string> = [];
	let rest = word;

	while (Bun.stringWidth(rest) > width) {
		const head = clip(rest, width);

		if (head === "") {
			break;
		}

		out.push(head);
		rest = rest.slice(head.length);
	}

	return [...out, rest];
};

export const wrap = (text: string, width: number): ReadonlyArray<string> => {
	const room = Math.max(1, width);
	const words = text.split(SPACE).filter((w) => w !== "");
	const lines: Array<string> = [];
	let current = "";

	for (const word of words.flatMap((w) => pieces(w, room))) {
		const joined = current === "" ? word : `${current} ${word}`;

		if (Bun.stringWidth(joined) <= room) {
			current = joined;
		} else {
			lines.push(current);
			current = word;
		}
	}

	return current === "" && lines.length > 0 ? lines : [...lines, current];
};

const tone =
	(t: ProseTone) =>
	(text: string): ProseLine => ({ text, tone: t });

const hung = (
	marker: string,
	text: string,
	width: number,
	t: ProseTone
): ReadonlyArray<ProseLine> => {
	const lead = Bun.stringWidth(marker);
	const pad = " ".repeat(lead);

	return wrap(text, width - lead).map((line, i) => ({
		text: `${i === 0 ? marker : pad}${line}`,
		tone: t,
	}));
};

const blockLines = (
	block: ProseBlock,
	width: number
): ReadonlyArray<ProseLine> => {
	switch (block.kind) {
		case "para": {
			return wrap(block.text, width).map(tone("text"));
		}

		case "heading": {
			return wrap(block.text, width).map(tone("heading"));
		}

		case "quote": {
			return wrap(block.text, width - 2).map((line) => ({
				text: `│ ${line}`,
				tone: "quote",
			}));
		}

		case "list": {
			return block.items.flatMap((item, i) =>
				hung(block.ordered ? `${i + 1}. ` : "• ", item, width, "list")
			);
		}

		case "pre": {
			return block.lines.map((line) => ({
				text: clip(line, width),
				tone: "pre",
			}));
		}

		default: {
			return [];
		}
	}
};

export const proseLines = (
	blocks: Prose,
	width: number
): ReadonlyArray<ProseLine> =>
	blocks.flatMap((block, i) =>
		i === 0
			? blockLines(block, width)
			: [{ text: "", tone: "text" as const }, ...blockLines(block, width)]
	);
