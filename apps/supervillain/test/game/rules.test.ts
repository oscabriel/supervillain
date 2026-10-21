import { describe, expect, test } from "bun:test";
import { fold } from "@supervillain/engine";
import {
  defaultLabel,
  FEED_LIMIT,
  feedLines,
  labelOf,
  nameOf,
  needsName,
  rules,
} from "../../src/game/index.ts";
import { ALICE, BOB, env, fixedDice, GM, GUEST, noDice, Table } from "./table.ts";

const feed = (table: Table) => {
  const state = table.state;
  return feedLines(state, labelOf(state));
};

describe("chat", () => {
  test("plain chat is posted as core.chat-posted and shows in the feed", () => {
    const table = new Table();
    expect(table.submit(ALICE, { type: "say", text: "hello table" })).toBeUndefined();
    expect(table.last?.type).toBe("core.chat-posted");
    expect(table.last?.payload).toEqual({ text: "hello table" });
    expect(feed(table)).toEqual([
      { seq: 1, who: "abcdefgh", kind: "chat", text: "hello table", gm: false },
    ]);
  });
});

describe("chat text", () => {
  const posted = (raw: string) => {
    const table = new Table();
    const refusal = table.submit(ALICE, { type: "say", text: raw });
    return refusal ?? (table.last?.payload as { text: string } | undefined)?.text;
  };

  test("pasted newlines and tabs become single spaces", () => {
    expect(posted("first line\r\nsecond\tline\n\nthird")).toBe("first line second line third");
  });

  test("ANSI escapes and control characters never reach the log", () => {
    expect(posted("\x1b[31mred\x1b[0m alert")).toBe("red alert");
    expect(posted("title\x1b]0;pwned\x07 change")).toBe("title change");
    expect(posted("bell\x07 and back\x08space\x7f")).toBe("bell and backspace");
    expect(posted("c1\x9b2J csi")).toBe("c1 csi");
  });

  test("bidi overrides are stripped", () => {
    expect(posted(`abc${String.fromCharCode(0x202e)}def`)).toBe("abcdef");
  });

  test("text that is empty once cleaned is refused", () => {
    expect(posted("   \x1b[2J  \n")).toBe("Say something.");
  });

  test("invisible format characters are stripped, so nothing blank gets posted", () => {
    expect(posted("a\u200bb\u2060c\u00add\ufeffe")).toBe("abcde");
    expect(posted("\u200b\u200b")).toBe("Say something.");
    expect(posted("\u3164 \u2800 \u{e0041}")).toBe("Say something.");
  });

  test("accents are composed, stray ones go, and a stack is cut to three", () => {
    expect(posted("cafe\u0301")).toBe("café");
    expect(posted("\u0301\u0301\u0301 zalgo \u0308x")).toBe("zalgo x");
    // q has no precomposed accented form, so every mark stays a mark.
    expect(posted(`q${"\u0301".repeat(10)}!`)).toBe(`q${"\u0301".repeat(3)}!`);
  });

  test("500 characters is fine, 501 is refused", () => {
    expect(posted("a".repeat(500))).toBe("a".repeat(500));
    expect(posted("a".repeat(501))).toBe("Keep it to 500 characters (that was 501).");
  });

  test("replay halts on a chat line holding an escape", () => {
    const folded = fold(rules, [env(1, "core.chat-posted", { text: "\x1b[2Jboo" })], {
      strict: true,
    });
    expect(folded.error?.seq).toBe(1);
    expect(folded.state.feed).toEqual([]);
  });
});

describe("emotes and narration", () => {
  test("/me posts an emote", () => {
    const table = new Table();
    table.submit(ALICE, { type: "me", text: "waves  at\neveryone" });
    expect(table.last?.payload).toEqual({ text: "waves at everyone", style: "emote" });
    expect(feed(table)).toEqual([
      { seq: 1, who: "abcdefgh", kind: "emote", text: "waves at everyone", gm: false },
    ]);
  });

  test("the GM narrates; a player is refused because narrate is GM-only", () => {
    const table = new Table();
    expect(table.submit(ALICE, { type: "narrate", text: "The door creaks." })).toBe(
      "Only the GM can use /narrate.",
    );
    expect(table.envelopes).toEqual([]);
    expect(table.submit(GM, { type: "narrate", text: "The door creaks." })).toBeUndefined();
    expect(table.last?.payload).toEqual({ text: "The door creaks.", style: "narration" });
    expect(feed(table)).toEqual([
      { seq: 1, who: "GM", kind: "narration", text: "The door creaks.", gm: true },
    ]);
  });
});

describe("names", () => {
  const named = (raw: string) => {
    const table = new Table();
    return table.submit(ALICE, { type: "name", name: raw }) ?? table.state.core.names[ALICE];
  };

  test("/name sets a display name with core.name-set, and the feed says who it was", () => {
    const table = new Table();
    expect(table.submit(ALICE, { type: "name", name: "Alice" })).toBeUndefined();
    expect(table.last?.type).toBe("core.name-set");
    expect(table.last?.payload).toEqual({ name: "Alice" });
    expect(nameOf(table.state, ALICE)).toBe("Alice");
    expect(feed(table)).toEqual([
      { seq: 1, who: "Alice", kind: "name", text: "abcdefgh is now Alice", gm: false },
    ]);
  });

  test("names are trimmed and their inner whitespace collapsed", () => {
    expect(named("  Vex   the\tBold  ")).toBe("Vex the Bold");
  });

  test("1 to 24 characters", () => {
    expect(named("V")).toBe("V");
    expect(named("x".repeat(24))).toBe("x".repeat(24));
    expect(named("x".repeat(25))).toBe("Keep names to 24 characters.");
    expect(named("   ")).toBe("Pick a name.");
  });

  test("control characters, escapes and invisible characters are refused, not stripped", () => {
    expect(named("Al\x1b[31mice")).toBe("Names can't hold control or invisible characters.");
    expect(named("Al\x00ice")).toBe("Names can't hold control or invisible characters.");
    for (const invisible of ["G\u200bM", "\u200b", "Vex\u2060", "\u3164", "\u2800", "a\u00adb"])
      expect(named(invisible)).toBe("Names can't hold control or invisible characters.");
  });

  test("stray or stacked accents are refused in a name", () => {
    expect(named("\u0301\u0301")).toBe("Names can't hold stray or stacked accents.");
    expect(named(`Ve${"\u0301".repeat(6)}x`)).toBe("Names can't hold stray or stacked accents.");
  });

  test("names are stored in compatibility form, so fullwidth letters are plain ones", () => {
    expect(named("\uff36\uff45\uff58")).toBe("Vex");
    expect(named("Ve\u0301ra")).toBe("V\u00e9ra");
  });

  test("a lookalike of a taken name is taken: other scripts' letters and digits for letters", () => {
    const table = new Table();
    table.submit(ALICE, { type: "name", name: "Vex the Bold" });
    expect(table.submit(BOB, { type: "name", name: "Vex the B\u043eld" })).toBe(
      '"Vex the B\u043eld" is taken; pick another name.',
    );
    expect(table.submit(BOB, { type: "name", name: "V\u0435x the B0ld" })).toBe(
      '"V\u0435x the B0ld" is taken; pick another name.',
    );
    expect(table.submit(BOB, { type: "name", name: "\uff27\uff2d" })).toBe(
      '"GM" is taken; pick another name.',
    );
  });

  test("a name can't carry the table's own markers", () => {
    expect(named("Bob (GM)")).toBe('"Bob (GM)" would read like a marker; pick another name.');
    expect(named("Bob (you)")).toBe('"Bob (you)" would read like a marker; pick another name.');
  });

  test("a name someone else has is refused, whatever its case", () => {
    const table = new Table();
    table.submit(ALICE, { type: "name", name: "Alice" });
    expect(table.submit(BOB, { type: "name", name: "aLiCe" })).toBe(
      '"aLiCe" is taken; pick another name.',
    );
  });

  test("another key's default label is taken, even after they pick a name", () => {
    const table = new Table();
    table.submit(BOB, { type: "say", text: "hi" });
    expect(table.submit(ALICE, { type: "name", name: "zyxwvuts" })).toBe(
      '"zyxwvuts" is taken; pick another name.',
    );
    table.submit(BOB, { type: "name", name: "Bob" });
    expect(table.submit(ALICE, { type: "name", name: "ZYXWVUTS" })).toBe(
      '"ZYXWVUTS" is taken; pick another name.',
    );
  });

  test("the default label of someone seated is taken before they write anything", () => {
    const table = new Table();
    expect(table.submit(BOB, { type: "name", name: "abcdefgh", seated: [ALICE, BOB] })).toBe(
      '"abcdefgh" is taken; pick another name.',
    );
  });

  test("a guest's name is held only while that guest is seated; a key's is held for good", () => {
    const table = new Table();
    table.submit(GUEST, { type: "name", name: "Wren" });
    table.submit(ALICE, { type: "name", name: "Vex" });
    expect(table.submit(BOB, { type: "name", name: "wren", seated: [GUEST, BOB] })).toBe(
      '"wren" is taken; pick another name.',
    );
    expect(table.submit(BOB, { type: "name", name: "Vex", seated: [BOB] })).toBe(
      '"Vex" is taken; pick another name.',
    );
    // The guest has gone, and a guest never comes back as the same actor: the name is free.
    expect(table.submit(BOB, { type: "name", name: "Wren", seated: [BOB] })).toBeUndefined();
  });

  test('"GM" is always taken, even if the GM has a name', () => {
    const table = new Table();
    expect(table.submit(ALICE, { type: "name", name: "gm" })).toBe(
      '"gm" is taken; pick another name.',
    );
    table.submit(GM, { type: "name", name: "Director" });
    expect(table.submit(ALICE, { type: "name", name: "GM" })).toBe(
      '"GM" is taken; pick another name.',
    );
    expect(table.submit(ALICE, { type: "name", name: "director" })).toBe(
      '"director" is taken; pick another name.',
    );
  });

  test("names that look like a guest's label are kept for guests", () => {
    expect(named("guest-beef")).toBe(
      '"guest-beef" looks like a guest\'s label; pick another name.',
    );
  });

  test("you may take your own default label, and change your name's case", () => {
    const table = new Table();
    expect(table.submit(ALICE, { type: "name", name: "abcdefgh" })).toBeUndefined();
    expect(table.submit(ALICE, { type: "name", name: "Vex" })).toBeUndefined();
    expect(table.submit(ALICE, { type: "name", name: "VEX" })).toBeUndefined();
    expect(table.submit(ALICE, { type: "name", name: "VEX" })).toBe("You're already VEX.");
  });

  test("a name given up is free again", () => {
    const table = new Table();
    table.submit(ALICE, { type: "name", name: "Vex" });
    table.submit(ALICE, { type: "name", name: "Ash" });
    expect(table.submit(BOB, { type: "name", name: "Vex" })).toBeUndefined();
  });

  test("a player without a name needs one; the GM never does", () => {
    const table = new Table();
    expect(needsName(table.state, ALICE)).toBe(true);
    expect(needsName(table.state, GM)).toBe(false);
    table.submit(ALICE, { type: "name", name: "Vex" });
    expect(needsName(table.state, ALICE)).toBe(false);
  });
});

describe("labels", () => {
  test("default labels: GM, eight characters of the key, guest and four characters", () => {
    expect(defaultLabel(GM)).toBe("GM");
    expect(defaultLabel(ALICE)).toBe("abcdefgh");
    expect(defaultLabel(GUEST)).toBe("guest-7f3a");
  });

  test("every line shows the actor's current name, so a rename relabels earlier lines", () => {
    const table = new Table();
    table.submit(ALICE, { type: "say", text: "who am I" });
    table.submit(ALICE, { type: "name", name: "Vex" });
    table.submit(ALICE, { type: "say", text: "Vex" });
    table.submit(ALICE, { type: "name", name: "Ash" });
    expect(feed(table)).toEqual([
      { seq: 1, who: "Ash", kind: "chat", text: "who am I", gm: false },
      { seq: 2, who: "Ash", kind: "name", text: "abcdefgh is now Vex", gm: false },
      { seq: 3, who: "Ash", kind: "chat", text: "Vex", gm: false },
      { seq: 4, who: "Ash", kind: "name", text: "Vex is now Ash", gm: false },
    ]);
  });

  test("names outlive the feed cap", () => {
    const log = [env(1, "core.name-set", { name: "Vex" }, ALICE)];
    for (let seq = 2; seq <= FEED_LIMIT + 2; seq++)
      log.push(env(seq, "core.chat-posted", { text: `line ${seq}` }));
    const state = fold(rules, log, { strict: true }).state;
    expect(state.feed).toHaveLength(FEED_LIMIT);
    expect(state.feed[0]?.seq).toBe(3);
    expect(labelOf(state)(ALICE)).toBe("Vex");
    const decision = rules.decide(state, BOB, { type: "name", name: "vex" }, noDice);
    expect(decision).toEqual({ refusal: '"vex" is taken; pick another name.' });
  });
});

describe("dice", () => {
  const roll = (notation: string, dice = noDice) => {
    const table = new Table();
    return table.submit(ALICE, { type: "roll", notation }, dice) ?? table;
  };

  test("2d10+3 rolls two d10s from the engine's dice and stores everything in the payload", () => {
    const table = roll("2d10+3", fixedDice(4, 9));
    if (typeof table === "string") throw new Error(table);
    expect(table.last?.type).toBe("core.dice-rolled");
    expect(table.last?.payload).toEqual({
      notation: "2d10+3",
      rolls: [4, 9],
      modifier: 3,
      total: 16,
    });
    expect(feed(table)).toEqual([
      { seq: 1, who: "abcdefgh", kind: "roll", text: "rolled 2d10+3: [4, 9] +3 = 16", gm: false },
    ]);
  });

  test("d20 means 1d20, and the notation is normalised", () => {
    const payloadOf = (notation: string, ...faces: number[]) => {
      const table = roll(notation, fixedDice(...faces));
      return typeof table === "string" ? table : table.last?.payload;
    };
    expect(payloadOf("d20", 17)).toEqual({ notation: "1d20", rolls: [17], modifier: 0, total: 17 });
    expect(payloadOf(" 3D6 - 1 ", 1, 2, 3)).toEqual({
      notation: "3d6-1",
      rolls: [1, 2, 3],
      modifier: -1,
      total: 5,
    });
  });

  test("1 to 100 dice of 2 to 1000 sides", () => {
    const faces = (n: number) => fixedDice(...Array.from({ length: n }, () => 1));
    expect(roll("100d6", faces(100))).toBeInstanceOf(Table);
    expect(roll("1d2", faces(1))).toBeInstanceOf(Table);
    expect(roll("1d1000", faces(1))).toBeInstanceOf(Table);
    expect(roll("0d6")).toBe("Roll 1 to 100 dice at a time.");
    expect(roll("101d6")).toBe("Roll 1 to 100 dice at a time.");
    expect(roll("d1")).toBe("Dice have 2 to 1000 sides.");
    expect(roll("d1001")).toBe("Dice have 2 to 1000 sides.");
    expect(roll("d6+1001")).toBe("Keep the modifier within 1000.");
  });

  test("anything else is not dice", () => {
    expect(roll("fireball")).toBe('"fireball" isn\'t dice; try 2d10+3, d20 or 3d6-1.');
    expect(roll("2d")).toBe('"2d" isn\'t dice; try 2d10+3, d20 or 3d6-1.');
    expect(roll("2d6+")).toBe('"2d6+" isn\'t dice; try 2d10+3, d20 or 3d6-1.');
  });

  test("dice that return a face outside 1..sides are a host bug, so decide throws", () => {
    expect(() => roll("1d6", fixedDice(7))).toThrow();
    expect(() => roll("1d6", fixedDice(2.5))).toThrow();
  });

  test("replay refuses a roll whose numbers don't add up", () => {
    const bad = [
      { notation: "2d10+3", rolls: [4, 9], modifier: 3, total: 99 },
      { notation: "2d10+3", rolls: [4], modifier: 3, total: 7 },
      { notation: "1d6", rolls: [7], modifier: 0, total: 7 },
      { notation: "1d6", rolls: [3], modifier: 1, total: 4 },
    ];
    for (const payload of bad) {
      const folded = fold(rules, [env(1, "core.dice-rolled", payload)], { strict: true });
      expect(folded.error?.seq).toBe(1);
    }
  });
});

describe("replay", () => {
  test("a log reproduces the state without decide or dice", () => {
    const log = [
      env(1, "core.name-set", { name: "Vex" }, ALICE),
      env(2, "core.chat-posted", { text: "hello" }, ALICE),
      env(
        3,
        "core.dice-rolled",
        { notation: "2d10+3", rolls: [4, 9], modifier: 3, total: 16 },
        ALICE,
      ),
      env(4, "core.chat-posted", { text: "The door creaks.", style: "narration" }),
      env(5, "core.chat-posted", { text: "waves", style: "emote" }, BOB),
    ];
    const folded = fold(rules, log, { strict: true });
    expect(folded.error).toBeUndefined();
    expect(folded.state).toEqual({
      seq: 5,
      actors: [ALICE, GM, BOB],
      feed: [
        { seq: 1, actor: ALICE, kind: "name", text: "abcdefgh is now Vex" },
        { seq: 2, actor: ALICE, kind: "chat", text: "hello" },
        { seq: 3, actor: ALICE, kind: "roll", text: "rolled 2d10+3: [4, 9] +3 = 16" },
        { seq: 4, actor: GM, kind: "narration", text: "The door creaks." },
        { seq: 5, actor: BOB, kind: "emote", text: "waves" },
      ],
      core: { names: { [ALICE]: "Vex" } },
    });
  });

  test("the same commands decided live and replayed from the log agree", () => {
    const table = new Table();
    table.submit(ALICE, { type: "name", name: "Vex" });
    table.submit(ALICE, { type: "roll", notation: "3d6" }, fixedDice(6, 5, 4));
    table.submit(GM, { type: "say", text: "nice" });
    let live = rules.initial;
    for (const envelope of table.envelopes) live = rules.apply(live, envelope);
    const replayed = fold(rules, JSON.parse(JSON.stringify(table.envelopes)), { strict: true });
    expect(replayed.state).toEqual(live);
  });

  test("a lenient reader skips another module's events; the writer halts on them", () => {
    const goblin = env(1, "draw-steel.creature-added", { name: "Goblin" });
    const log = [goblin, env(2, "core.chat-posted", { text: "hi" })];
    expect(fold(rules, log, { strict: false }).skipped).toEqual([goblin]);
    expect(fold(rules, log, { strict: true }).error).toEqual({
      seq: 1,
      message: 'unknown event type "draw-steel.creature-added"',
    });
  });
});
