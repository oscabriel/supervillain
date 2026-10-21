import { describe, expect, test } from "bun:test";
import { fold } from "@supervillain/engine";
import { core } from "../../src/game/core.ts";
import { compose, type Module } from "../../src/game/module.ts";
import { commands, feedLines, rules } from "../../src/game/index.ts";
import { ALICE, env, fixedDice, GM } from "./table.ts";

type CounterCommand = { readonly type: "bump"; readonly by: number } | { readonly type: "reset" };

/** A second module, standing in for Draw Steel. */
const counter: Module<"counter", { readonly n: number }, CounterCommand> = {
  key: "counter",
  initial: { n: 0 },
  events: ["counter.bumped", "counter.reset"],
  commands: {
    bump: {
      usage: "/bump <n>",
      summary: "Bump the counter.",
      gmOnly: false,
      parse: (args) => ({ type: "bump", by: Number(args) }),
      complete: (slice, partial, actor) => [`${partial}${slice.n} for ${actor}`],
    },
    reset: {
      usage: "/reset",
      summary: "Reset the counter.",
      gmOnly: true,
      parse: () => ({ type: "reset" }),
    },
  },
  decide: (_slice, _shared, _actor, command, dice) =>
    command.type === "bump"
      ? { events: [{ type: "counter.bumped", payload: { by: command.by + dice(6) } }] }
      : { events: [{ type: "counter.reset", payload: {} }] },
  apply: (slice, envelope) =>
    envelope.type === "counter.bumped"
      ? {
          slice: { n: slice.n + (envelope.payload as { by: number }).by },
          feed: { kind: "counter", text: "bumped" },
        }
      : { slice: { n: 0 } },
};

describe("compose", () => {
  test("a module's completer sees its own slice, the partial argument and who is typing", () => {
    const table = compose([core, counter]);
    const bump = table.commands.find((c) => c.name === "bump");
    expect(bump?.complete?.(table.rules.initial, "+", ALICE)).toEqual([`+0 for ${ALICE}`]);
  });

  test("the table's registry is every core command, in order, with its GM-only flag", () => {
    expect(commands.map((c) => [c.name, c.gmOnly])).toEqual([
      ["say", false],
      ["me", false],
      ["narrate", true],
      ["name", false],
      ["roll", false],
    ]);
  });

  test("each module keeps its own slice; events dispatch by type; GM-only holds across modules", () => {
    const table = compose([core, counter]);
    expect(table.rules.initial).toEqual({
      seq: 0,
      actors: [],
      feed: [],
      core: { names: {} },
      counter: { n: 0 },
    });
    expect(table.commands.map((c) => c.name)).toEqual([
      "say",
      "me",
      "narrate",
      "name",
      "roll",
      "bump",
      "reset",
    ]);
    const start = table.rules.initial;
    expect(table.rules.decide(start, ALICE, { type: "reset" }, fixedDice())).toEqual({
      refusal: "Only the GM can use /reset.",
    });
    expect(table.rules.decide(start, ALICE, { type: "bump", by: 2 }, fixedDice(3))).toEqual({
      events: [{ type: "counter.bumped", payload: { by: 5 } }],
    });
    const log = [
      env(1, "counter.bumped", { by: 5 }, ALICE),
      env(2, "core.name-set", { name: "Vex" }, ALICE),
      env(3, "counter.reset", {}),
      env(4, "counter.bumped", { by: 1 }),
    ];
    expect(fold(table.rules, log, { strict: true }).state).toEqual({
      seq: 4,
      actors: [ALICE, GM],
      feed: [
        { seq: 1, actor: ALICE, kind: "counter", text: "bumped" },
        { seq: 2, actor: ALICE, kind: "name", text: "abcdefgh is now Vex" },
        { seq: 4, actor: GM, kind: "counter", text: "bumped" },
      ],
      core: { names: { [ALICE]: "Vex" } },
      counter: { n: 1 },
    });
    expect(rules.knows("counter.bumped")).toBe(false);
  });

  test("an event out of seq order halts replay", () => {
    const folded = fold(
      rules,
      [env(1, "core.chat-posted", { text: "a" }), env(1, "core.chat-posted", { text: "b" })],
      { strict: true },
    );
    expect(folded.error).toEqual({ seq: 1, message: "seq 1 does not follow seq 1" });
  });

  test("two modules can't claim the same command, event or key; events must be namespaced", () => {
    expect(() => compose([counter, counter])).toThrow('Two modules claim the state key "counter".');
    expect(() => compose([counter, { ...counter, key: "other", events: [] }])).toThrow(
      'Two modules claim the command "bump".',
    );
    const stray = { ...counter, events: ["bumped"] } as unknown as typeof counter;
    expect(() => compose([stray])).toThrow('Event "bumped" is not namespaced under "counter".');
  });
});

describe("the registry's types", () => {
  test("a missing or extra command spec fails to compile", () => {
    const spec = counter.commands.reset;
    type Slice = { readonly n: number };
    // @ts-expect-error -- "bump" has no spec
    const missing: Module<"m", Slice, CounterCommand>["commands"] = { reset: spec };
    const extra: Module<"m", Slice, { readonly type: "reset" }>["commands"] = {
      reset: spec,
      // @ts-expect-error -- there is no "jump" command
      jump: spec,
    };
    expect([missing, extra]).toHaveLength(2);
  });
});

describe("feedLines", () => {
  test("labels come from the labeller handed in, at projection time", () => {
    const state = fold(rules, [env(1, "core.chat-posted", { text: "hi" }, ALICE)], {
      strict: true,
    }).state;
    expect(feedLines(state, (actor) => `<${actor.slice(0, 3)}>`)).toEqual([
      { seq: 1, who: "<key>", kind: "chat", text: "hi", gm: false },
    ]);
  });
});
