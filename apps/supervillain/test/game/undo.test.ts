import { describe, expect, test } from "bun:test";
import { fold } from "@supervillain/engine";
import { core } from "../../src/game/core.ts";
import { compose, type Module } from "../../src/game/module.ts";
import { feedLines, plainText, tableLabel } from "../../src/game/index.ts";
import { VEX } from "../drawSteel/harness.ts";
import { ALICE, BOB, env, GM, START, Table } from "./table.ts";

type CounterCommand =
  | { readonly type: "bump"; readonly by: ReadonlyArray<number> }
  | { readonly type: "pin"; readonly at: number }
  | { readonly type: "spin" }
  | { readonly type: "look" }
  | { readonly type: "set"; readonly from: number; readonly to: number };

type Counter = { readonly n: number; readonly pin?: number };

/**
 * A stand-in game module: `counter.bumped` is retractable, `counter.pinned` lives in the same
 * slice but isn't, the way a hero claim sits beside damage in Draw Steel. `counter.spun` rolls a
 * die; `counter.looked` changes nothing, like a measurement, and can't be applied while the
 * counter is 0; `counter.set` holds only where the counter is what it was decided against.
 */
const counter: Module<"counter", Counter, CounterCommand> = {
  key: "counter",
  initial: { n: 0 },
  events: ["counter.bumped", "counter.pinned", "counter.spun", "counter.looked", "counter.set"],
  retractable: ["counter.bumped", "counter.spun", "counter.set"],
  rolled: (envelope) => envelope.type === "counter.spun",
  commands: {
    bump: {
      usage: "/bump <n>",
      summary: "Bump the counter.",
      gmOnly: false,
      parse: (args) => ({ type: "bump", by: [Number(args)] }),
    },
    pin: {
      usage: "/pin <n>",
      summary: "Pin the counter.",
      gmOnly: false,
      parse: (args) => ({ type: "pin", at: Number(args) }),
    },
    spin: { usage: "/spin", summary: "Add a d6.", gmOnly: false, parse: () => ({ type: "spin" }) },
    look: { usage: "/look", summary: "Look.", gmOnly: false, parse: () => ({ type: "look" }) },
    set: {
      usage: "/set <n>",
      summary: "Set the counter.",
      gmOnly: false,
      parse: (args) => ({ type: "set", from: 0, to: Number(args) }),
    },
  },
  decide: (slice, _shared, _actor, command, dice) => {
    switch (command.type) {
      case "bump":
        return { events: command.by.map((by) => ({ type: "counter.bumped", payload: { by } })) };
      case "pin":
        return { events: [{ type: "counter.pinned", payload: { at: command.at } }] };
      case "spin":
        return { events: [{ type: "counter.spun", payload: { face: dice(6) } }] };
      case "look":
        return { events: [{ type: "counter.looked", payload: {} }] };
      case "set":
        return { events: [{ type: "counter.set", payload: { from: slice.n, to: command.to } }] };
    }
  },
  apply: (slice, envelope) => {
    switch (envelope.type) {
      case "counter.bumped": {
        const { by } = envelope.payload as { by: number };
        const n = slice.n + by;
        return { slice: { ...slice, n }, feed: { kind: "counter", text: `+${by} → ${n}` } };
      }
      case "counter.spun": {
        const { face } = envelope.payload as { face: number };
        const n = slice.n + face;
        return { slice: { ...slice, n }, feed: { kind: "counter", text: `spun ${face} → ${n}.` } };
      }
      case "counter.looked":
        if (slice.n === 0) throw new Error("nothing to look at");
        return { slice, feed: { kind: "counter", text: `looked at ${slice.n}` } };
      case "counter.set": {
        const { from, to } = envelope.payload as { from: number; to: number };
        if (slice.n !== from) throw new Error(`set from ${from}, but it's ${slice.n}`);
        return { slice: { ...slice, n: to }, feed: { kind: "counter", text: `set to ${to}.` } };
      }
      default: {
        const { at } = envelope.payload as { at: number };
        return { slice: { ...slice, pin: at }, feed: { kind: "counter", text: `pinned at ${at}` } };
      }
    }
  },
};

const toy = compose([core, counter]);
const undo = { type: "undo" } as const;
const redo = { type: "redo" } as const;
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();

describe("undo, in compose and the fold", () => {
  test("takes back the latest batch whole, restoring the slice from before it, newest first", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "bump", by: [5] });
    t.run(ALICE, { type: "bump", by: [2, 3] });
    expect(t.state.counter).toEqual({ n: 10 });

    t.run(GM, undo);
    expect(t.last).toMatchObject({
      seq: 4,
      actor: GM,
      type: "core.retracted",
      payload: { seqs: [2, 3], undone: ["+2 → 7", "+3 → 10"] },
    });
    expect(t.state.counter).toEqual({ n: 5 });

    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 0 });
    expect(t.submit(GM, undo)).toBe("Nothing to undo.");
    // Append-only: every event is still in the log.
    expect(t.envelopes.map((e) => e.type)).toEqual([
      "counter.bumped",
      "counter.bumped",
      "counter.bumped",
      "core.retracted",
      "core.retracted",
    ]);
  });

  test("a log with a retraction in it replays to the same state, without decide", () => {
    const log = [
      env(1, "counter.bumped", { by: 5 }, GM, at(0)),
      env(2, "counter.bumped", { by: 2 }, ALICE, at(1)),
      env(3, "counter.bumped", { by: 3 }, ALICE, at(1)),
      env(4, "core.chat-posted", { text: "oops" }, ALICE, at(2)),
      env(5, "core.retracted", { seqs: [2, 3], undone: ["+2 → 7", "+3 → 10"] }, GM, at(3)),
    ];
    const folded = fold(toy.rules, log, { strict: true });
    expect(folded.error).toBeUndefined();
    expect(folded.state.counter).toEqual({ n: 5 });
    expect(folded.state.feed).toEqual([
      { seq: 1, actor: GM, kind: "counter", text: "+5 → 5" },
      { seq: 2, actor: ALICE, kind: "counter", text: "+2 → 7" },
      { seq: 3, actor: ALICE, kind: "counter", text: "+3 → 10" },
      { seq: 4, actor: ALICE, kind: "chat", text: "oops" },
      { seq: 5, actor: GM, kind: "undo", text: "undid: +2 → 7; +3 → 10" },
    ]);
    expect(folded.state.undo.map((b) => b.seqs)).toEqual([[1]]);
    // What the live table decided is what replay rebuilds, the stack included.
    const t = new Table(toy.rules);
    t.run(GM, { type: "bump", by: [5] });
    t.run(ALICE, { type: "bump", by: [2, 3] });
    t.run(ALICE, { type: "say", text: "oops" });
    t.run(GM, undo);
    expect(t.envelopes).toEqual(log);
    let live = toy.rules.initial;
    for (const e of t.envelopes) live = toy.rules.apply(live, e);
    expect(folded.state).toEqual(live);
  });

  test("the stack holds 20 batches; the oldest falls off", () => {
    const t = new Table(toy.rules);
    for (let i = 0; i < 21; i++) t.run(GM, { type: "bump", by: [1] });
    expect(t.state.undo).toHaveLength(20);
    for (let i = 0; i < 20; i++) t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 1 });
    expect(t.submit(GM, undo)).toBe("Nothing to undo.");
  });

  test("events that aren't retractable stay put, in any slice, and the feed keeps every line", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "bump", by: [5] });
    t.run(ALICE, { type: "say", text: "nice" });
    t.run(ALICE, { type: "name", name: "Wren" });
    t.run(ALICE, { type: "roll", notation: "1d6" }, () => 4);
    t.run(GM, { type: "pin", at: 3 });
    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 0, pin: 3 });
    expect(t.state.core).toEqual({ names: { [ALICE]: "Wren" } });
    expect(t.state.feed.map((e) => e.text)).toEqual([
      "+5 → 5",
      "nice",
      "abcdefgh is now Wren",
      "rolled 1d6: [4] = 4",
      "pinned at 3",
      "undid: +5 → 5",
    ]);
  });

  test("a batch is the retractable events of one submission: one actor, one timestamp, unbroken", () => {
    const batches = (...log: ReturnType<typeof env>[]) =>
      fold(toy.rules, log, { strict: true }).state.undo.map((b) => b.seqs);
    // Two actors in the same millisecond are two batches.
    expect(
      batches(env(1, "counter.bumped", { by: 1 }, GM), env(2, "counter.bumped", { by: 1 }, ALICE)),
    ).toEqual([[1], [2]]);
    // An event that isn't retractable splits a submission's batch in two.
    expect(
      batches(
        env(1, "counter.bumped", { by: 1 }),
        env(2, "counter.pinned", { at: 1 }),
        env(3, "counter.bumped", { by: 1 }),
      ),
    ).toEqual([[1], [3]]);
    // Two submissions by one actor with one timestamp can't be told apart, so they are one batch.
    // The room never stamps two submissions alike (packages/engine Room), so only a log written
    // by hand has this.
    expect(
      batches(env(1, "counter.bumped", { by: 1 }), env(2, "counter.bumped", { by: 1 })),
    ).toEqual([[1, 2]]);
  });

  test("a retraction of no batch on the stack, or of one a later batch depends on, halts replay", () => {
    const halted = (...log: ReturnType<typeof env>[]) =>
      fold(toy.rules, log, { strict: true }).error;
    expect(
      halted(
        env(1, "counter.bumped", { by: 1 }, GM, at(0)),
        env(2, "counter.bumped", { by: 1 }, GM, at(1)),
        env(3, "core.retracted", { seqs: [1, 2], undone: [] }, GM, at(2)),
      ),
    ).toEqual({
      seq: 3,
      message: "the retraction at seq 3 names no batch that can be undone (seq 1, 2)",
    });
    expect(
      halted(
        env(1, "counter.bumped", { by: 1 }, GM, at(0)),
        env(2, "counter.set", { from: 1, to: 5 }, GM, at(1)),
        env(3, "core.retracted", { seqs: [1], undone: [] }, GM, at(2)),
      ),
    ).toEqual({
      seq: 3,
      message: "the retraction at seq 3 would break a later change: set from 1, but it's 0",
    });
    expect(halted(env(1, "core.retracted", { seqs: [1], undone: [] }))).toEqual({
      seq: 1,
      message: "the retraction at seq 1 has nothing to take back",
    });
  });
});

describe("what compose checks", () => {
  test("a module's retractable events are its own; /undo and its event belong to compose", () => {
    const stray = { ...counter, retractable: ["counter.reset"] } as unknown as typeof counter;
    expect(() => compose([stray])).toThrow(
      '"counter.reset" is retractable but not one of "counter"\'s events.',
    );
    const undoing = { ...counter, commands: { ...counter.commands, undo: counter.commands.pin } };
    expect(() => compose([undoing])).toThrow("/undo belongs to compose.");
    const retracting = { ...core, events: [...core.events, "core.retracted"] } as typeof core;
    expect(() => compose([retracting])).toThrow('"core.retracted" belongs to compose, for /undo.');
  });
});

describe("a player's undo", () => {
  const withNow = (t: { readonly now: string }) => ({ type: "undo", now: t.now }) as const;

  test("takes back their own latest batch within 30 seconds", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "bump", by: [2] });
    t.run(BOB, { type: "say", text: "chat doesn't count" });
    t.wait(28); // 30 seconds after Alice's bump
    t.run(ALICE, withNow(t));
    expect(t.state.counter).toEqual({ n: 0 });
  });

  test("not after 30 seconds, though the GM still can", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "bump", by: [2] });
    t.wait(30); // 31 seconds after
    expect(t.submit(ALICE, withNow(t))).toBe(
      "Too late: you can take back your own change for 30 seconds. Ask the GM.",
    );
    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 0 });
  });

  test("only their own: their latest batch, even with someone else's after it", () => {
    const t = new Table(toy.rules);
    expect(t.submit(ALICE, withNow(t))).toBe("Nothing to undo.");
    t.run(GM, { type: "bump", by: [5] });
    expect(t.submit(ALICE, withNow(t))).toBe("Only the GM can take back someone else's change.");
    t.run(ALICE, { type: "bump", by: [2] });
    t.run(BOB, { type: "bump", by: [1] });
    t.run(ALICE, withNow(t));
    // Bob's bump stays: it is folded again onto the counter as it was before Alice's.
    expect(t.state.counter).toEqual({ n: 6 });
    expect(t.state.feed.at(-1)?.text).toBe("undid: +2 → 7");
    expect(t.state.undo.map((b) => b.actor)).toEqual([GM, BOB]);
    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 5 });
  });

  test("not when a later change depends on it; the GM takes that back first", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "bump", by: [2] });
    t.run(BOB, { type: "set", from: 0, to: 7 });
    expect(t.submit(ALICE, withNow(t))).toBe("A later change depends on it; ask the GM.");
    expect(t.submit(GM, { type: "undo", who: "Alice", whose: ALICE })).toBe(
      "A later change depends on it; undo that first.",
    );
    t.run(GM, undo);
    t.run(ALICE, withNow(t));
    expect(t.state.counter).toEqual({ n: 0 });
  });

  test("never a batch that rolled dice: the GM's alone, so nobody rolls again by undoing", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "spin" }, () => 1);
    expect(t.submit(ALICE, withNow(t))).toBe(
      "That change rolled dice, so only the GM can take it back.",
    );
    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 0 });
  });

  test("a measurement or anything else that changes nothing never stands in the way", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "bump", by: [5] });
    t.run(ALICE, { type: "bump", by: [2] });
    t.run(BOB, { type: "look" });
    t.run(ALICE, withNow(t));
    expect(t.state.counter).toEqual({ n: 5 });
    t.run(BOB, { type: "look" });
    t.run(GM, undo);
    // The look couldn't be folded into the stack's oldest snapshot (n is 0 there), and needn't be.
    expect(t.state.counter).toEqual({ n: 0 });
    expect(t.state.undo).toEqual([]);
  });

  test("needs the time from the host", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "bump", by: [2] });
    expect(t.submit(ALICE, undo)).toBe(
      "The host didn't say what time it is, so only the GM can undo.",
    );
  });
});

describe("undo at the Draw Steel table", () => {
  test("the feed says who undid what, in the undone lines' own words", () => {
    const t = new Table();
    t.run(GM, { type: "name", name: "Oscar" });
    t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
    t.run(GM, { type: "dmg", who: "vex", amount: 14 });
    t.run(GM, undo);
    const state = t.state;
    expect(feedLines(state, tableLabel(state)).map(plainText).slice(-2)).toEqual([
      "Vex takes 14 damage → 7/21 · winded",
      "↶ Oscar undid: Vex takes 14 damage → 7/21 · winded",
    ]);
    expect(state.ds.heroes[0]?.stamina).toBe(21);
  });

  test("a claim is never undone, and undo can still go back past the hero's arrival", () => {
    const t = new Table();
    t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
    t.run(GM, { type: "hero", hero: "kor", sheet: { ...VEX, id: "kor", name: "Kor" } });
    t.run(GM, { type: "dmg", who: "vex", amount: 5 });
    t.run(ALICE, { type: "play", hero: "vex" });
    // The claim can't be folded into the snapshots from before Vex came, and needn't be: Vex
    // isn't in them. So the GM keeps every batch.
    expect(t.state.undo).toHaveLength(3);
    t.run(GM, undo);
    expect(t.state.ds.heroes[0]).toMatchObject({ stamina: 21, player: ALICE });
    t.run(GM, undo);
    t.run(GM, undo);
    expect(t.state.ds.heroes).toEqual([]);
    expect(t.submit(GM, undo)).toBe("Nothing to undo.");
  });

  test("the undone lines are joined without doubled stops", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "spin" }, () => 3);
    t.run(GM, { type: "set", from: 3, to: 9 });
    t.run(GM, undo);
    expect(t.state.feed.at(-1)?.text).toBe("undid: set to 9.");
    const two = new Table(toy.rules);
    two.envelopes.push(
      env(1, "counter.spun", { face: 3 }, GM, at(0)),
      env(2, "counter.set", { from: 3, to: 9 }, GM, at(0)),
    );
    two.run(GM, undo);
    expect(two.state.feed.at(-1)?.text).toBe("undid: spun 3 → 3; set to 9.");
  });
});

describe("redo", () => {
  test("puts back what the latest undo took, from the log, so its dice aren't rolled again", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "spin" }, () => 4);
    t.run(GM, undo);
    expect(t.state.counter).toEqual({ n: 0 });
    t.run(GM, redo);
    expect(t.last).toMatchObject({ type: "core.redone", payload: { seqs: [1] } });
    expect(t.state.counter).toEqual({ n: 4 });
    expect(t.state.feed.at(-1)?.text).toBe("redid: spun 4 → 4.");
    // What was redone can be undone again, and redone again.
    t.run(GM, undo);
    t.run(GM, redo);
    expect(t.state.counter).toEqual({ n: 4 });
    expect(t.submit(GM, redo)).toBe("Nothing to redo.");
  });

  test("walks forward through several undos, newest undo first", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "bump", by: [5] });
    t.run(BOB, { type: "bump", by: [1] });
    t.run(GM, undo);
    t.run(GM, undo);
    t.run(GM, redo);
    expect(t.state.counter).toEqual({ n: 5 });
    t.run(GM, redo);
    expect(t.state.counter).toEqual({ n: 6 });
  });

  test("a player redoes only an undo they did; any new change ends the redo", () => {
    const t = new Table(toy.rules);
    t.run(ALICE, { type: "bump", by: [2] });
    t.run(GM, undo);
    expect(t.submit(ALICE, redo)).toBe("Only the GM can redo someone else's undo.");
    t.run(GM, redo);
    t.run(ALICE, { type: "undo", now: t.now });
    t.run(ALICE, redo);
    expect(t.state.counter).toEqual({ n: 2 });
    t.run(ALICE, { type: "undo", now: t.now });
    t.run(BOB, { type: "bump", by: [1] });
    expect(t.submit(ALICE, redo)).toBe("Nothing to redo.");
  });

  test("a change that isn't retractable doesn't end it, and a redone log replays", () => {
    const t = new Table(toy.rules);
    t.run(GM, { type: "set", from: 0, to: 3 });
    t.run(GM, undo);
    t.run(GM, { type: "pin", at: 1 });
    t.run(GM, redo);
    expect(t.state.counter).toEqual({ n: 3, pin: 1 });
    const replayed = fold(toy.rules, t.envelopes, { strict: true });
    expect(replayed.error).toBeUndefined();
    expect(replayed.state).toEqual(t.state);
  });
});

describe("a lenient reader", () => {
  test("takes back a batch that held an event it doesn't know", () => {
    const log = [
      env(1, "counter.bumped", { by: 5 }, GM, at(0)),
      env(2, "counter.bumped", { by: 2 }, ALICE, at(1)),
      env(3, "counter.future-thing", {}, ALICE, at(1)),
      env(4, "core.retracted", { seqs: [2, 3], undone: ["+2 → 7", "?"] }, GM, at(2)),
    ];
    const folded = fold(toy.rules, log, { strict: false });
    expect(folded.error).toBeUndefined();
    expect(folded.skipped.map((e) => e.seq)).toEqual([3]);
    expect(folded.state.counter).toEqual({ n: 5 });
  });
});
