const CODE_POINTS = /(?:)/u;

export const charsOf = (text: string): Array<string> => text.split(CODE_POINTS);

const ESC = 0x1b;

const BEL = 0x07;

const CSI = 0x9b;

const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);

const within = (cp: number, low: number, high: number): boolean =>
	cp >= low && cp <= high;

const codeOf = (char: string | undefined): number => char?.codePointAt(0) ?? -1;

export const isControl = (cp: number): boolean =>
	within(cp, 0x00, 0x1f) || within(cp, 0x7f, 0x9f);

const isStripped = (cp: number): boolean =>
	isControl(cp) && !within(cp, 0x09, 0x0d);

const BIDI_CONTROLS = new Set([0x06_1c, 0x20_0e, 0x20_0f]);

const isTerminalControl = (cp: number): boolean =>
	isControl(cp) ||
	BIDI_CONTROLS.has(cp) ||
	within(cp, 0x20_2a, 0x20_2e) ||
	within(cp, 0x20_66, 0x20_69);

const skipWhile = (
	chars: ReadonlyArray<string>,
	start: number,
	low: number,
	high: number
): number => {
	let at = start;

	while (within(codeOf(chars[at]), low, high)) {
		at += 1;
	}

	return at;
};

const skipControlSequence = (
	chars: ReadonlyArray<string>,
	start: number
): number => {
	const parameters = skipWhile(chars, start, 0x30, 0x3f);
	const intermediates = skipWhile(chars, parameters, 0x20, 0x2f);

	return within(codeOf(chars[intermediates]), 0x40, 0x7e)
		? intermediates + 1
		: intermediates;
};

const skipControlString = (
	chars: ReadonlyArray<string>,
	start: number
): number => {
	let at = start;

	while (
		at < chars.length &&
		codeOf(chars[at]) !== BEL &&
		codeOf(chars[at]) !== ESC
	) {
		at += 1;
	}

	if (codeOf(chars[at]) === BEL) {
		return at + 1;
	}

	return codeOf(chars[at]) === ESC && chars[at + 1] === "\\" ? at + 2 : at;
};

const skipEscape = (chars: ReadonlyArray<string>, at: number): number => {
	const next = chars[at + 1];

	if (next === "[") {
		return skipControlSequence(chars, at + 2);
	}

	if (next !== undefined && STRING_INTRODUCERS.has(next)) {
		return skipControlString(chars, at + 2);
	}

	return Math.min(at + 2, chars.length);
};

const stripEscapes = (text: string): string => {
	const chars = charsOf(text);
	let out = "";
	let at = 0;

	while (at < chars.length) {
		const char = chars[at] ?? "";
		const cp = codeOf(char);

		if (cp === ESC) {
			at = skipEscape(chars, at);
		} else if (cp === CSI) {
			at = skipControlSequence(chars, at + 1);
		} else {
			out += char;
			at += 1;
		}
	}

	return out;
};

const stripControls = (text: string): string =>
	charsOf(text)
		.filter((char) => !isStripped(codeOf(char)))
		.join("");

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;

const UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/u;

const MARK = /\p{M}/u;

const SPACE = /\s/u;

const SPACES = /\s+/gu;

const ZWNJ = "\u200C";

const ZWJ = "\u200D";

const VS15 = "\uFE0E";

const VS16 = "\uFE0F";

const JOINERS = new Set([ZWNJ, ZWJ, VS15, VS16]);

const visible = (char: string | undefined): char is string =>
	char !== undefined && !JOINERS.has(char) && !SPACE.test(char);

const keepsJoiner = (
	char: string,
	last: string | undefined,
	next: string | undefined
): boolean => {
	if (char === ZWJ || char === ZWNJ) {
		return (
			last !== undefined &&
			last !== ZWJ &&
			last !== ZWNJ &&
			!SPACE.test(last) &&
			visible(next) &&
			!MARK.test(next)
		);
	}

	return visible(last) && !MARK.test(last);
};

const placeJoiners = (text: string): string => {
	const chars = charsOf(text);
	let out = "";
	let last: string | undefined;

	for (const [i, char] of chars.entries()) {
		if (!JOINERS.has(char)) {
			out += char;
			last = char;
		} else if (keepsJoiner(char, last, chars[i + 1])) {
			out += char;
			last = char;
		}
	}

	return out;
};

const MARKS_MAX = 3;

const tidyMarks = (text: string): string => {
	let out = "";
	let marks = 0;
	let base = false;

	for (const char of text) {
		if (JOINERS.has(char)) {
			out += char;
		} else if (MARK.test(char)) {
			if (base && marks < MARKS_MAX) {
				out += char;
				marks += 1;
			}
		} else {
			out += char;
			base = char !== " ";
			marks = 0;
		}
	}

	return out;
};

export const cleanText = (raw: string): string => {
	const text = stripControls(stripEscapes(raw))
		.normalize("NFC")
		.replaceAll(INVISIBLE, (char) => (JOINERS.has(char) ? char : ""))
		.replaceAll(SPACES, " ")
		.trim();

	return placeJoiners(tidyMarks(text)).replaceAll(SPACES, " ").trim();
};

export const hasControls = (text: string): boolean => UNSAFE.test(text);

export const hasTerminalControls = (text: string): boolean =>
	charsOf(text).some((char) => isTerminalControl(codeOf(char)));

const LATIN = /\p{Script=Latin}/u;

const OTHER_SCRIPT =
	/(?!\p{Script=Latin}|\p{Script=Common}|\p{Script=Inherited})\p{L}/u;

export const mixesLatin = (text: string): boolean =>
	LATIN.test(text) && OTHER_SCRIPT.test(text);

export const lengthOf = (text: string): number => charsOf(text).length;

export const orList = (items: ReadonlyArray<string>): string =>
	items.length <= 1
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

export const quote = (raw: string, max = 24): string => {
	const text = cleanText(raw);

	return lengthOf(text) > max
		? `${cleanText(
				charsOf(text)
					.slice(0, max - 1)
					.join("")
			)}…`
		: text;
};

const LOOKALIKES = new Map(
	Object.entries({
		А: "A",
		В: "B",
		Е: "E",
		К: "K",
		М: "M",
		Н: "H",
		О: "O",
		Р: "P",
		С: "C",
		Т: "T",
		У: "Y",
		Х: "X",
		І: "I",
		Ј: "J",
		Ѕ: "S",
		Ԛ: "Q",
		Ԝ: "W",
		Ү: "Y",
		Һ: "H",
		Ӏ: "I",
		а: "a",
		е: "e",
		о: "o",
		р: "p",
		с: "c",
		у: "y",
		х: "x",
		і: "i",
		ј: "j",
		ѕ: "s",
		ԁ: "d",
		ԛ: "q",
		ԝ: "w",
		һ: "h",
		ӏ: "l",
		ү: "y",
		Α: "A",
		Β: "B",
		Ε: "E",
		Ζ: "Z",
		Η: "H",
		Ι: "I",
		Κ: "K",
		Μ: "M",
		Ν: "N",
		Ο: "O",
		Ρ: "P",
		Τ: "T",
		Υ: "Y",
		Χ: "X",
		α: "a",
		ι: "i",
		κ: "k",
		ν: "v",
		ο: "o",
		ρ: "p",
		υ: "u",
		χ: "x",
		γ: "y",
		ı: "i",
		ɑ: "a",
		ɡ: "g",
	})
);

const DIGIT_LOOKALIKES = new Map(
	Object.entries({
		"0": "o",
		"1": "l",
	})
);

const folded = (name: string): string => {
	const latin = charsOf(name.normalize("NFKC").replaceAll(INVISIBLE, ""))
		.map((char) => LOOKALIKES.get(char) ?? char)
		.join("")
		.toLowerCase()
		.replaceAll("i", "l");

	return charsOf(latin)
		.map((char) => DIGIT_LOOKALIKES.get(char) ?? char)
		.join("")
		.replaceAll("rn", "m")
		.replaceAll(SPACES, " ")
		.trim();
};

export const nameKey = (name: string): string =>
	folded(name).replaceAll(/[\s\p{P}]/gu, "");

export const looksLikeGuestLabel = (name: string): boolean =>
	folded(name).startsWith("guest-");
