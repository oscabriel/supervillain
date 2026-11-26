import { ifDefined } from "@supervillain/domain";

import {
	ATX,
	BLANK,
	BULLET,
	CLOSING_MARKS,
	closesFence,
	fenceOf,
	INDENTED,
	NUMBERED,
	QUOTE,
	RULE,
	SETEXT,
	TIGHT_ATX,
} from "./blocks.ts";
import type { Fence } from "./blocks.ts";

export interface Frontmatter {
	readonly yaml: string;
	readonly body: string;
	readonly bodyLine: number;
}

export interface FrontmatterProblem {
	readonly problem: string;
	readonly line?: number;
}

export interface Section {
	readonly level: number;
	readonly heading: string;
	readonly line: number;
	readonly textLine: number;
	readonly text: string;
}

export interface SectionProblem {
	readonly line: number;
	readonly message: string;
}

export interface Sections {
	readonly preamble: string;
	readonly sections: ReadonlyArray<Section>;
	readonly firstLine: number;
	readonly problems: ReadonlyArray<SectionProblem>;
	readonly sealedAt?: number;
}

const BOM = /^﻿/u;

const CRLF = /\r\n?/gu;

const OPEN = /^---[ \t]*$/u;

const CLOSE = /^(?:---|\.\.\.)[ \t]*$/u;

const DECOR = /[*`~]/gu;

const UNDER_SPACE = /_+/gu;

const SPACES = /\s+/gu;

const EDGES = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

const GM_HEADING =
	/^(?:g\.?\s?m\.?s?|gmnotes?|game[\s-]?masters?|d\.?\s?m\.?s?|dungeon[\s-]?masters?|director(?:['’]s|s['’]?)?\s+(?:notes?|only|eyes\s+only)|secrets?)(?![\p{L}\p{N}])/iu;

const SECRET = /^secrets?(?![\p{L}\p{N}])/iu;

const GM_MENTION =
	/(?<![\p{L}\p{N}])(?:gms?|gmnotes?|game[\s-]?masters?|dms?|dungeon[\s-]?masters?|directors?(?:['’]s)?|spoilers?)(?![\p{L}\p{N}])/iu;

const LABEL_LINE =
	/^ {0,3}(?:(?<mark>\*\*|__|\*|_)(?<marked>.+?)\k<mark>|(?<colon>.+?):)[ \t]*:?[ \t]*$/u;

const READ_ALOUD = /^read[ -]aloud$/iu;

const COMMENT_OPEN = "<!--";

const COMMENT_CLOSE = "-->";

export const normalized = (text: string): string =>
	text.replace(BOM, "").replaceAll(CRLF, "\n");

export const splitFrontmatter = (
	text: string
): Frontmatter | FrontmatterProblem => {
	const lines = normalized(text).split("\n");

	if (!OPEN.test(lines[0] ?? "")) {
		return {
			problem: "must begin with a --- line, then its fields, then --- again",
			line: 1,
		};
	}

	const close = lines.findIndex((line, i) => i > 0 && CLOSE.test(line));

	if (close === -1) {
		return {
			problem: "opens its fields with --- but never closes them with ---",
			line: 1,
		};
	}

	return {
		yaml: lines.slice(1, close).join("\n"),
		body: lines.slice(close + 1).join("\n"),
		bodyLine: close + 2,
	};
};

const headingWords = (heading: string): string =>
	heading
		.replaceAll(DECOR, "")
		.replaceAll(UNDER_SPACE, " ")
		.replaceAll(EDGES, "")
		.replaceAll(SPACES, " ")
		.trim();

export const isGmHeading = (heading: string): boolean =>
	GM_HEADING.test(headingWords(heading));

export const mentionsGm = (heading: string): boolean =>
	!isGmHeading(heading) && GM_MENTION.test(headingWords(heading));

export const isReadAloud = (heading: string): boolean =>
	READ_ALOUD.test(headingWords(heading));

type LineKind = "fence" | "html" | "text";

interface Scan {
	readonly lines: ReadonlyArray<string>;
	readonly kinds: ReadonlyArray<LineKind>;
	readonly unclosed: ReadonlyArray<number>;
}

interface Uncommented {
	readonly text: string;
	readonly open: boolean;
	readonly closed: boolean;
}

const closeOf = (rest: string, justOpened: boolean): number => {
	if (justOpened && rest.startsWith(">")) {
		return 1;
	}

	if (justOpened && rest.startsWith("->")) {
		return 2;
	}

	const end = rest.indexOf(COMMENT_CLOSE);

	return end === -1 ? -1 : end + COMMENT_CLOSE.length;
};

const uncomment = (
	rest: string,
	open: boolean,
	kept: string,
	closed: boolean,
	justOpened: boolean
): Uncommented => {
	if (open) {
		const end = closeOf(rest, justOpened);

		return end === -1
			? { text: kept, open: true, closed }
			: uncomment(rest.slice(end), false, kept, true, false);
	}

	const start = rest.indexOf(COMMENT_OPEN);

	return start === -1
		? { text: `${kept}${rest}`, open: false, closed }
		: uncomment(
				rest.slice(start + COMMENT_OPEN.length),
				true,
				`${kept}${rest.slice(0, start)}`,
				closed,
				true
			);
};

interface Scanned {
	readonly lines: Array<string>;
	readonly kinds: Array<LineKind>;
	readonly open?: number;
}

const scanOnce = (
	raw: ReadonlyArray<string>,
	demoted: ReadonlySet<number>
): Scanned => {
	const lines: Array<string> = [];
	const kinds: Array<LineKind> = [];
	let fence: { readonly fence: Fence; readonly at: number } | undefined;
	let comment = false;

	for (const [i, line] of raw.entries()) {
		if (fence !== undefined) {
			lines.push(line);
			kinds.push("fence");
			fence = closesFence(line, fence.fence) ? undefined : fence;
			continue;
		}

		const opened = comment || demoted.has(i) ? undefined : fenceOf(line);

		if (opened !== undefined) {
			lines.push(line);
			kinds.push("fence");
			fence = { fence: opened, at: i };
			continue;
		}

		const wasOpen = comment;
		const stripped = uncomment(line, comment, "", false, false);
		comment = stripped.open;
		lines.push(stripped.text);
		kinds.push(wasOpen ? "html" : "text");
	}

	return fence === undefined
		? { lines, kinds }
		: { lines, kinds, open: fence.at };
};

const scanOf = (
	raw: ReadonlyArray<string>,
	demoted: ReadonlySet<number> = new Set()
): Scan => {
	const once = scanOnce(raw, demoted);

	return once.open === undefined
		? {
				lines: once.lines,
				kinds: once.kinds,
				unclosed: [...demoted].toSorted((a, b) => a - b),
			}
		: scanOf(raw, new Set([...demoted, once.open]));
};

const headingText = (raw: string | undefined): string =>
	(raw ?? "").replace(CLOSING_MARKS, "").trim();

interface Heading {
	readonly level: number;
	readonly heading: string;
	readonly at: number;
	readonly from: number;
}

interface Found {
	readonly headings: ReadonlyArray<Heading>;
	readonly problems: ReadonlyArray<{
		readonly at: number;
		readonly message: string;
	}>;
}

const UNDERLINE_IN_GM =
	"has a --- or === under a line of GM notes, which Markdown reads as a heading; leave a blank line above it, or use *** for a rule";

const TIGHT_GM =
	"has a GM heading with no space after its #s; write it like ## GM Notes";

const mentionProblem = (heading: string): string =>
	`has the heading "${heading}", which mentions the GM but doesn't hide anything; start it with GM, like ## GM Notes, to keep it from the players, or reword it`;

const labelProblem = (line: string): string =>
	`has "${line.trim()}" on a line of its own, which looks like a GM heading but isn't one, so the text under it reaches the players; write it like ## GM Notes`;

const atxOf = (
	line: string
):
	| { readonly level: number; readonly text: string; readonly tight: boolean }
	| undefined => {
	const atx = ATX.exec(line)?.groups;

	if (atx !== undefined) {
		return {
			level: atx.marks?.length ?? 1,
			text: headingText(atx.text),
			tight: false,
		};
	}

	const tight = TIGHT_ATX.exec(line)?.groups;
	const text = headingText(tight?.text);

	return tight !== undefined && isGmHeading(text)
		? { level: tight.marks?.length ?? 1, text, tight: true }
		: undefined;
};

const labelLike = (line: string): boolean => {
	const label = LABEL_LINE.exec(line)?.groups;
	const text = label?.marked ?? label?.colon;

	return (
		text !== undefined && isGmHeading(text) && !SECRET.test(headingWords(text))
	);
};

interface Walk {
	readonly lines: ReadonlyArray<string>;
	readonly headings: Array<Heading>;
	readonly problems: Array<{ readonly at: number; readonly message: string }>;
	paraStart: number | undefined;
	paraOther: boolean;
	gmLevel: number | undefined;
}

const reset = (walk: Walk) => {
	walk.paraStart = undefined;
	walk.paraOther = false;
};

const push = (walk: Walk, heading: Heading) => {
	walk.headings.push(heading);

	if (walk.gmLevel !== undefined && heading.level <= walk.gmLevel) {
		walk.gmLevel = undefined;
	}

	if (walk.gmLevel === undefined && isGmHeading(heading.heading)) {
		walk.gmLevel = heading.level;
	}

	if (walk.gmLevel === undefined && mentionsGm(heading.heading)) {
		walk.problems.push({
			at: heading.at,
			message: mentionProblem(heading.heading),
		});
	}

	reset(walk);
};

const atxStep = (walk: Walk, line: string, i: number): boolean => {
	const atx = atxOf(line);

	if (atx === undefined) {
		return false;
	}

	if (atx.tight) {
		walk.problems.push({ at: i, message: TIGHT_GM });
	}

	push(walk, { level: atx.level, heading: atx.text, at: i, from: i });

	return true;
};

const setextStep = (walk: Walk, line: string, i: number): boolean => {
	const under = SETEXT.exec(line)?.groups?.under;
	const { paraStart } = walk;

	if (under === undefined || paraStart === undefined || walk.paraOther) {
		return false;
	}

	if (walk.gmLevel !== undefined) {
		walk.problems.push({ at: i, message: UNDERLINE_IN_GM });
		reset(walk);

		return true;
	}

	push(walk, {
		level: under.startsWith("=") ? 1 : 2,
		heading: walk.lines
			.slice(paraStart, i)
			.map((l) => l.trim())
			.join(" "),
		at: paraStart,
		from: i,
	});

	return true;
};

const otherStep = (walk: Walk, line: string, i: number): boolean => {
	const block =
		QUOTE.test(line) ||
		BULLET.test(line) ||
		NUMBERED.test(line) ||
		(walk.paraStart === undefined && INDENTED.test(line));

	if (!block) {
		return false;
	}

	walk.paraStart = i;
	walk.paraOther = true;

	return true;
};

const textStep = (walk: Walk, line: string, i: number) => {
	if (walk.gmLevel === undefined && labelLike(line)) {
		walk.problems.push({ at: i, message: labelProblem(line) });
	}

	walk.paraStart ??= i;
};

const lineStep = (walk: Walk, kind: LineKind | undefined, i: number) => {
	const line = walk.lines[i] ?? "";

	if (kind === "fence" || BLANK.test(line)) {
		reset(walk);

		return;
	}

	if (kind === "html") {
		walk.paraStart ??= i;
		walk.paraOther = true;

		return;
	}

	if (atxStep(walk, line, i) || setextStep(walk, line, i)) {
		return;
	}

	if (RULE.test(line)) {
		reset(walk);

		return;
	}

	if (!otherStep(walk, line, i)) {
		textStep(walk, line, i);
	}
};

const headingsOf = (scan: Scan): Found => {
	const walk: Walk = {
		lines: scan.lines,
		headings: [],
		problems: [],
		paraStart: undefined,
		paraOther: false,
		gmLevel: undefined,
	};

	for (const [i, kind] of scan.kinds.entries()) {
		lineStep(walk, kind, i);
	}

	return { headings: walk.headings, problems: walk.problems };
};

const UNCLOSED =
	"opens a code fence that never closes; close it with the same ``` or ~~~";

export const sectionsOf = (body: string, firstLine = 1): Sections => {
	const scan = scanOf(normalized(body).split("\n"));
	const { lines } = scan;
	const found = headingsOf(scan);
	const { headings } = found;
	const [first] = headings;
	const [sealed] = scan.unclosed;

	const preamble = lines
		.slice(0, first === undefined ? lines.length : first.at)
		.join("\n");

	const sections = headings.map((h, i): Section => {
		const next = headings[i + 1];

		return {
			level: h.level,
			heading: h.heading,
			line: firstLine + h.at,
			textLine: firstLine + h.from + 1,
			text: lines
				.slice(h.from + 1, next === undefined ? lines.length : next.at)
				.join("\n"),
		};
	});

	const problems: ReadonlyArray<SectionProblem> = [
		...scan.unclosed.map((at) => ({ at, message: UNCLOSED })),
		...found.problems,
	]
		.toSorted((a, b) => a.at - b.at)
		.map((p) => ({ line: firstLine + p.at, message: p.message }));

	return {
		preamble,
		sections,
		firstLine,
		problems,
		...ifDefined(sealed, (at) => ({ sealedAt: firstLine + at })),
	};
};

const before = (text: string, from: number, sealedAt: number): string =>
	text
		.split("\n")
		.slice(0, Math.max(0, sealedAt - from))
		.join("\n");

const visible = (parsed: Sections): Sections => {
	const { sealedAt } = parsed;

	if (sealedAt === undefined) {
		return parsed;
	}

	return {
		...parsed,
		preamble: before(parsed.preamble, parsed.firstLine, sealedAt),
		sections: parsed.sections
			.filter((s) => s.line < sealedAt)
			.map((s) => ({ ...s, text: before(s.text, s.textLine, sealedAt) })),
	};
};

const blocksOf = (
	sections: ReadonlyArray<Section>,
	starts: (s: Section) => boolean
): ReadonlyArray<boolean> => {
	const inBlock: Array<boolean> = [];
	let level: number | undefined;

	for (const s of sections) {
		if (level !== undefined && s.level <= level) {
			level = undefined;
		}

		if (level === undefined && starts(s)) {
			({ level } = s);
		}

		inBlock.push(level !== undefined);
	}

	return inBlock;
};

const gmBlocks = (sections: ReadonlyArray<Section>): ReadonlyArray<boolean> =>
	blocksOf(sections, (s) => isGmHeading(s.heading));

const rendered = (s: Section): string =>
	`${"#".repeat(s.level)} ${s.heading}\n${s.text}`;

export const playerSafe = (
	parsed: Sections,
	omit: (heading: string) => boolean = () => false
): string => {
	const shown = visible(parsed);
	const gm = gmBlocks(shown.sections);
	const omitted = blocksOf(shown.sections, (s) => omit(s.heading));

	return [
		shown.preamble,
		...shown.sections.flatMap((s, i) =>
			gm[i] === true || omitted[i] === true ? [] : [rendered(s)]
		),
	]
		.join("\n")
		.trim();
};

export const gmOnly = (parsed: Sections): string => {
	const gm = gmBlocks(parsed.sections);

	return parsed.sections
		.flatMap((s, i) => (gm[i] === true ? [rendered(s)] : []))
		.join("\n")
		.trim();
};

export const readAloudOf = (parsed: Sections): string | undefined => {
	const shown = visible(parsed);
	const gm = gmBlocks(shown.sections);
	const within = blocksOf(shown.sections, (s) => isReadAloud(s.heading));

	const parts = shown.sections.flatMap((s, i) => {
		if (gm[i] === true || within[i] !== true) {
			return [];
		}

		return isReadAloud(s.heading) ? [s.text] : [rendered(s)];
	});

	const text = parts.join("\n").trim();

	return text === "" ? undefined : text;
};
