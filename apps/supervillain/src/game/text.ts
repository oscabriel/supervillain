// Players' text is drawn on other players' terminals, so nothing a terminal would act on may reach the state.
// Matching control characters is the point of these patterns.
/* oxlint-disable no-control-regex */

// ESC sequences: CSI (ESC [ ... final), OSC/DCS/SOS/PM/APC strings (ending in BEL or ESC \), then any other ESC pair.
const ESCAPES =
  /\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\s\S]?|\x9b[0-?]*[ -/]*[@-~]?/g;
// C0 and C1 controls and DEL, except the whitespace ones.
const CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;

/* oxlint-enable no-control-regex */

// What draws as nothing, or reorders what is drawn: format characters (zero-width spaces and
// joiners, bidi marks and overrides, the soft hyphen, tags), every other default-ignorable code
// point (the Hangul fillers, variation selectors) and the blank braille pattern.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/u;
const MARK = /\p{M}/u;

// The invisible characters writing needs: ZWNJ and ZWJ shape Persian and Indic words and join
// emoji (the family), VS15 and VS16 pick text or emoji presentation. Chat keeps them in place.
const ZWNJ = "\u200c";
const ZWJ = "\u200d";
const VS15 = "\ufe0e";
const VS16 = "\ufe0f";
const JOINERS = new Set([ZWNJ, ZWJ, VS15, VS16]);

/** A character that draws something: not whitespace, a joiner or a selector. */
const visible = (char: string | undefined) =>
  char !== undefined && !JOINERS.has(char) && !/\s/.test(char);

/**
 * Keeps a joiner (ZWJ, ZWNJ) only between two visible characters, the second not a combining
 * mark, and a selector (VS15, VS16) only straight after a visible base character. So none
 * survives at either end, beside a space, twice in a row, or on a line with nothing else.
 */
function placeJoiners(text: string): string {
  const chars = [...text];
  let out = "";
  let last: string | undefined;
  for (const [i, char] of chars.entries()) {
    if (!JOINERS.has(char)) {
      out += char;
      last = char;
      continue;
    }
    const next = chars[i + 1];
    const keep =
      char === ZWJ || char === ZWNJ
        ? last !== undefined &&
          last !== ZWJ &&
          last !== ZWNJ &&
          !/\s/.test(last) &&
          visible(next) &&
          !MARK.test(next!)
        : visible(last) && !MARK.test(last!);
    if (keep) {
      out += char;
      last = char;
    }
  }
  return out;
}

/** Combining marks kept on one character. Real scripts need two or three; zalgo needs dozens. */
const MARKS_MAX = 3;

/**
 * Drops combining marks with nothing to sit on, and any past the third on one character.
 * Joiners and selectors pass through without counting as a character, so they can't reset the count.
 */
function tidyMarks(text: string): string {
  let out = "";
  let marks = 0;
  let base = false;
  for (const char of text) {
    if (JOINERS.has(char)) {
      out += char;
      continue;
    }
    if (MARK.test(char)) {
      if (base && marks < MARKS_MAX) {
        out += char;
        marks++;
      }
      continue;
    }
    out += char;
    base = char !== " ";
    marks = 0;
  }
  return out;
}

/**
 * Makes untrusted text safe for one feed line: escape sequences, control characters and
 * invisible characters go (bar joiners and selectors where writing needs them), accents are
 * composed (NFC) with stray or stacked ones dropped, every run of whitespace (pasted newlines
 * and tabs included) becomes one space, and the ends are trimmed.
 */
export function cleanText(raw: string): string {
  const text = raw
    .replace(ESCAPES, "")
    .replace(CONTROLS, "")
    .normalize("NFC")
    .replace(INVISIBLE, (char) => (JOINERS.has(char) ? char : ""))
    .replace(/\s+/g, " ")
    .trim();
  // Marks first, so a joiner is placed against the characters that stay.
  return placeJoiners(tidyMarks(text)).replace(/\s+/g, " ").trim();
}

/** Whether text holds anything a terminal would act on, or that draws as nothing or reorders what it shows. */
export const hasControls = (text: string): boolean => UNSAFE.test(text);

// C0 (ESC among them), DEL and C1, and the bidi controls: fixed sets, not Unicode properties.
// oxlint-disable-next-line no-control-regex
const TERMINAL_CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Whether text holds a control a terminal acts on or a bidi control that reorders a line. Unlike
 * `cleanText`, this never changes with a Unicode upgrade or a new cleaning rule, so replay can
 * hold stored text to it without an old log ever halting the writer.
 */
export const hasTerminalControls = (text: string): boolean => TERMINAL_CONTROLS.test(text);

const LATIN = /\p{Script=Latin}/u;
const OTHER_SCRIPT = /(?!\p{Script=Latin}|\p{Script=Common}|\p{Script=Inherited})\p{L}/u;

/**
 * Whether text has Latin letters beside letters of another script, as "Vеx" with a Cyrillic е
 * does. Digits, punctuation and accents belong to no script, so they never count.
 */
export const mixesLatin = (text: string): boolean => LATIN.test(text) && OTHER_SCRIPT.test(text);

/** Length in code points, so an emoji counts once rather than as two UTF-16 units. */
export const lengthOf = (text: string): number => [...text].length;

/** Untrusted text quoted back in a message: cleaned and cut short. */
export const quote = (raw: string, max = 24): string => {
  const text = cleanText(raw);
  // Cleaned again once cut, so no joiner is left hanging off the end.
  return lengthOf(text) > max ? `${cleanText([...text].slice(0, max - 1).join(""))}…` : text;
};

// Letters from other scripts that draw like Latin ones, by case, and digits that draw like
// lowercase letters. Not all of Unicode's confusables, but the ones a keyboard switch reaches.
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
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
  // Greek
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
  // Latin
  ı: "i",
  ɑ: "a",
  ɡ: "g",
};
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = { "0": "o", "1": "l" };

/** A name folded to what it looks like, spaces and punctuation still in. See `nameKey`. */
function folded(name: string): string {
  const latin = [...name.normalize("NFKC").replace(INVISIBLE, "")]
    .map((char) => LOOKALIKES[char] ?? char)
    .join("")
    // A capital I draws like a lowercase l, and lowercasing would lose which it was.
    .replace(/I/g, "l")
    .toLowerCase();
  return [...latin]
    .map((char) => DIGIT_LOOKALIKES[char] ?? char)
    .join("")
    .replace(/rn/g, "m")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What a name looks like, for telling whether two names would be mistaken for each other:
 * compatibility-normalised (NFKC), invisible characters removed, lookalike letters folded to
 * Latin, a capital I read as an l, lowercased, 0 and 1 read as o and l and rn as m, and spaces
 * and punctuation (but brackets) dropped. "Vex", "VEX", "Ｖｅｘ", "V e x." and "Vеx" with a
 * Cyrillic е all look like "vex".
 */
export const nameKey = (name: string): string => folded(name).replace(/(?![()])[\s\p{P}]/gu, "");

/** Whether a name reads like a guest's default label, "guest-7f3a". */
export const looksLikeGuestLabel = (name: string): boolean => folded(name).startsWith("guest-");
