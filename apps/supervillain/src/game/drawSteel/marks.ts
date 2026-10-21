/**
 * Token marks: the one or two characters a hero or creature is drawn with on the map, which
 * commands also take as its name (state.ts `resolve`).
 */
import type { Who } from "./state.ts";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = LETTERS + DIGITS;
/** Past a creature's own digits, letters from the end of the alphabet, least like a word's initial. */
const OVERFLOW = DIGITS + [...LETTERS].reverse().join("");

/** A name's words in plain letters and digits: "Goblin Warrior 2" is ["goblin", "warrior", "2"]. */
const wordsOf = (name: string): string[] =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter((w) => w !== "");

/**
 * The marks a hero or creature would like, best first, and the characters to pair with its
 * initial when all of those are taken. A hero: their initial, upper case, then the initial and
 * another letter of the name ("Ki"). A creature: its initial, lower case, with its number ("g2"),
 * a squad with its letter ("gA"), a lone creature alone ("g"); then the same with the initial of
 * each later word of the name ("ga" for a Goblin Archer). A creature numbered past 9 can't fit
 * its number, so it takes its initial and the number's last digit ("g0" for 10), else the first
 * free digit, else a letter from the end of the alphabet ("gz"): never the bare initial, which
 * reads as a lone creature.
 */
function wanted(who: Who): { readonly own: string[]; readonly pairs: string } {
  if (who.kind === "hero") {
    const [first = "", ...rest] = wordsOf(who.name).join("");
    const initial = first.toUpperCase();
    return {
      own: initial === "" ? [] : [initial, ...rest.map((c) => `${initial}${c}`)],
      pairs: ALNUM,
    };
  }
  const { creature } = who;
  const numbered = /-(\d+)$/.exec(creature.id)?.[1];
  const squad = creature.squad === undefined ? undefined : /-([a-z])$/.exec(creature.id)?.[1];
  const suffix = squad?.toUpperCase() ?? numbered;
  const words = wordsOf(creature.name);
  if (suffix !== undefined && words.at(-1)?.toUpperCase() === suffix.toUpperCase()) words.pop();
  const initials = words.map((w) => w[0]!);
  if (numbered !== undefined && squad === undefined && numbered.length > 1)
    return { own: initials.slice(0, 1).map((i) => `${i}${numbered.at(-1)}`), pairs: OVERFLOW };
  if (suffix !== undefined) return { own: initials.map((i) => `${i}${suffix}`), pairs: ALNUM };
  const [first, ...later] = initials;
  return {
    own: first === undefined ? [] : [first, ...later.map((i) => `${first}${i}`)],
    pairs: ALNUM,
  };
}

/**
 * Every hero's and creature's mark, unique, at most two characters, in the order they came to the
 * table, so a mark never changes while its creature stays. Whoever finds every mark it wants
 * taken gets the first free pair after its initial, else any free pair.
 */
export function marksOf(everyone: ReadonlyArray<Who>): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const result = new Map<string, string>();
  const free = (candidates: Iterable<string>) => {
    for (const m of candidates) if (!taken.has(m)) return m;
    return undefined;
  };
  function* pairs(initial: string, chars: string) {
    for (const c of chars) yield `${initial}${c}`;
  }
  function* anyPair() {
    for (const a of ALNUM) for (const b of ALNUM) yield `${a}${b}`;
  }
  for (const who of everyone) {
    const { own, pairs: chars } = wanted(who);
    const initial = own[0]?.[0] ?? (who.kind === "hero" ? "X" : "x");
    const mark = free(own) ?? free(pairs(initial, chars)) ?? free(anyPair()) ?? "??";
    taken.add(mark);
    result.set(who.id, mark);
  }
  return result;
}
