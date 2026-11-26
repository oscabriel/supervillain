import { charsOf, cleanText, isControl } from "@supervillain/domain";
import type { Prose, ProseBlock } from "@supervillain/domain";

import {
	ATX,
	BLANK,
	BULLET,
	CLOSING_MARKS,
	closesFence,
	fenceOf,
	NUMBERED,
	QUOTE,
	RULE,
	SETEXT,
} from "./blocks.ts";
import type { Fence } from "./blocks.ts";
import { normalized } from "./markdown.ts";

const CONTINUED = /^(?: {2,}|\t)(?<text>\S.*)$/u;

const IMAGE = /!\[(?<alt>[^\]]*)\]\([^)]*\)/gu;

const LINK = /\[(?<text>[^\]]+)\]\([^)]*\)/gu;

const STRONG = /(?<mark>\*\*|__)(?<text>\S(?:.*?\S)?)\k<mark>/gu;

const CODE = /`(?<text>[^`]+)`/gu;

const TAB = /\t/gu;

const inline = (text: string): string =>
	cleanText(
		text
			.replaceAll(IMAGE, "$<alt>")
			.replaceAll(LINK, "$<text>")
			.replaceAll(STRONG, "$<text>")
			.replaceAll(CODE, "$<text>")
	);

const preLine = (line: string): string =>
	charsOf(line.replaceAll(TAB, "    "))
		.filter((char) => !isControl(char.codePointAt(0) ?? 0))
		.join("")
		.trimEnd();

type Pending =
	| { readonly kind: "none" }
	| { readonly kind: "para"; readonly lines: Array<string> }
	| { readonly kind: "quote"; readonly lines: Array<string> }
	| {
			readonly kind: "list";
			readonly ordered: boolean;
			readonly items: Array<string>;
	  };

const NONE: Pending = { kind: "none" };

const finished = (pending: Pending): ReadonlyArray<ProseBlock> => {
	switch (pending.kind) {
		case "para": {
			const text = inline(pending.lines.join(" "));

			return text === "" ? [] : [{ kind: "para", text }];
		}

		case "quote": {
			const text = inline(pending.lines.join(" "));

			return text === "" ? [] : [{ kind: "quote", text }];
		}

		case "list": {
			const items = pending.items.map(inline).filter((item) => item !== "");

			return items.length === 0
				? []
				: [{ kind: "list", ordered: pending.ordered, items }];
		}

		case "none": {
			return [];
		}

		default: {
			return [];
		}
	}
};

const heading = (level: number, raw: string): ReadonlyArray<ProseBlock> => {
	const text = inline(raw.replace(CLOSING_MARKS, ""));

	return text === "" ? [] : [{ kind: "heading", level, text }];
};

interface Parser {
	readonly blocks: Array<ProseBlock>;
	pending: Pending;
	fence: Fence | undefined;
	pre: Array<string>;
}

const flush = (p: Parser) => {
	p.blocks.push(...finished(p.pending));
	p.pending = NONE;
};

const fenced = (p: Parser, line: string): boolean => {
	const { fence } = p;

	if (fence === undefined) {
		return false;
	}

	if (closesFence(line, fence)) {
		p.blocks.push({ kind: "pre", lines: p.pre });
		p.fence = undefined;
		p.pre = [];
	} else {
		p.pre.push(preLine(line));
	}

	return true;
};

const opensFence = (p: Parser, line: string): boolean => {
	const opened = fenceOf(line);

	if (opened === undefined) {
		return false;
	}

	flush(p);
	p.fence = opened;

	return true;
};

const blank = (p: Parser, line: string): boolean => {
	if (!BLANK.test(line)) {
		return false;
	}

	flush(p);

	return true;
};

const atxHeading = (p: Parser, line: string): boolean => {
	const atx = ATX.exec(line)?.groups;

	if (atx === undefined) {
		return false;
	}

	flush(p);
	p.blocks.push(...heading(atx.marks?.length ?? 1, atx.text ?? ""));

	return true;
};

const setextHeading = (p: Parser, line: string): boolean => {
	const { pending } = p;

	if (pending.kind !== "para" || !SETEXT.test(line)) {
		return false;
	}

	const last = pending.lines.pop() ?? "";
	flush(p);
	p.blocks.push(...heading(line.trim().startsWith("=") ? 1 : 2, last));

	return true;
};

const rule = (p: Parser, line: string): boolean => {
	if (!RULE.test(line)) {
		return false;
	}

	flush(p);

	return true;
};

const quote = (p: Parser, line: string): boolean => {
	const quoted = QUOTE.exec(line)?.groups;

	if (quoted === undefined) {
		return false;
	}

	if (p.pending.kind !== "quote") {
		flush(p);
		p.pending = { kind: "quote", lines: [] };
	}

	if (p.pending.kind === "quote") {
		p.pending.lines.push(quoted.text ?? "");
	}

	return true;
};

const listItem = (p: Parser, line: string): boolean => {
	const bullet = BULLET.exec(line)?.groups?.text;
	const numbered = NUMBERED.exec(line)?.groups?.text;
	const item = bullet ?? numbered;

	if (item === undefined) {
		return false;
	}

	const ordered = numbered !== undefined && bullet === undefined;

	if (p.pending.kind !== "list" || p.pending.ordered !== ordered) {
		flush(p);
		p.pending = { kind: "list", ordered, items: [] };
	}

	if (p.pending.kind === "list") {
		p.pending.items.push(item);
	}

	return true;
};

const continuation = (p: Parser, line: string): boolean => {
	const { pending } = p;
	const continued = CONTINUED.exec(line)?.groups?.text;

	if (pending.kind !== "list" || continued === undefined) {
		return false;
	}

	const at = pending.items.length - 1;
	pending.items[at] = `${pending.items[at] ?? ""} ${continued}`;

	return true;
};

const paragraph = (p: Parser, line: string): boolean => {
	if (p.pending.kind !== "para") {
		flush(p);
		p.pending = { kind: "para", lines: [] };
	}

	if (p.pending.kind === "para") {
		p.pending.lines.push(line.trim());
	}

	return true;
};

const STEPS: ReadonlyArray<(p: Parser, line: string) => boolean> = [
	fenced,
	opensFence,
	blank,
	atxHeading,
	setextHeading,
	rule,
	quote,
	listItem,
	continuation,
	paragraph,
];

export const proseOf = (markdown: string): Prose => {
	const parser: Parser = {
		blocks: [],
		pending: NONE,
		fence: undefined,
		pre: [],
	};

	for (const line of normalized(markdown).split("\n")) {
		STEPS.some((step) => step(parser, line));
	}

	if (parser.fence !== undefined) {
		parser.blocks.push({ kind: "pre", lines: parser.pre });
	}

	flush(parser);

	return parser.blocks;
};
