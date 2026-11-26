export interface Fence {
	readonly char: string;
	readonly length: number;
}

const FENCE = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/u;

export const ATX = /^ {0,3}(?<marks>#{1,6})(?:[ \t]+(?<text>.*?))?[ \t]*$/u;

export const TIGHT_ATX = /^ {0,3}(?<marks>#{1,6})(?<text>[^#\s].*?)[ \t]*$/u;

export const CLOSING_MARKS = /[ \t]+#+$|^#+$/u;

export const SETEXT = /^ {0,3}(?<under>=+|-+)[ \t]*$/u;

export const RULE =
	/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

export const QUOTE = /^ {0,3}>[ \t]?(?<text>.*)$/u;

export const BULLET = /^ {0,3}[-*+][ \t]+(?<text>.*)$/u;

export const NUMBERED = /^ {0,3}\d{1,9}[.)][ \t]+(?<text>.*)$/u;

export const INDENTED = /^(?: {4}|\t)/u;

export const BLANK = /^\s*$/u;

export const fenceOf = (line: string): Fence | undefined => {
	const groups = FENCE.exec(line)?.groups;
	const fence = groups?.fence;

	if (fence === undefined) {
		return undefined;
	}

	const char = fence[0] ?? "`";

	return char === "`" && (groups?.info ?? "").includes("`")
		? undefined
		: { char, length: fence.length };
};

export const closesFence = (line: string, open: Fence): boolean => {
	const fence = fenceOf(line);

	return (
		fence !== undefined &&
		fence.char === open.char &&
		fence.length >= open.length &&
		line.trim().length === fence.length
	);
};
