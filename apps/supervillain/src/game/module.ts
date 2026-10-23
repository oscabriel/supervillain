import type { Decision, Dice, Envelope, Rules } from "@supervillain/engine";
import * as Schema from "effect/Schema";
import { hasTerminalControls, quote } from "./text.ts";

/** The GM's local seat. The only actor that may run a GM-only command. */
export const GM = "gm";

/** How many feed lines the state keeps. Names live elsewhere, so labels never depend on this cap. */
export const FEED_LIMIT = 500;

/** How many batches /undo can walk back through. */
const UNDO_DEPTH = 20;

/** How long a player may take back their own latest batch. The GM has no limit. */
export const UNDO_WINDOW_MS = 30_000;

/** The corrective event /undo writes. Compose owns it, whichever modules it composes. */
const RETRACTED = "core.retracted";

/** The event /redo writes, putting back what the latest undo took. Compose owns it too. */
const REDONE = "core.redone";

export type Refused = { readonly refusal: string };

/**
 * One command's contract, projected to every surface: the input line, Tab completion and /help.
 * `gmOnly` is the one GM-only table: the composed `decide` enforces it, and help and completion read it.
 */
export interface CommandSpec<C, S> {
  /** Shown in /help, e.g. "/roll <dice>". A usage with no space takes no arguments. */
  readonly usage: string;
  readonly summary: string;
  readonly gmOnly: boolean;
  /**
   * What is typed for it, when that isn't its type. Two rulesets may each have a command typed
   * the same way (`/map` loads Draw Steel's map or set.world's), since a table offers one ruleset's;
   * their types stay apart, so the rules know whose it is.
   */
  readonly name?: string;
  /** Turns the text after the command name into a command, or refuses early with a usage hint. */
  readonly parse: (args: string) => C | Refused;
  /**
   * Candidate argument strings for a partial argument; each replaces the whole argument text.
   * `actor` is who is typing, so a command can offer, say, their own hero first.
   */
  readonly complete?: (slice: S, partial: string, actor: string) => ReadonlyArray<string>;
}

/** One spec per command type, no more and no fewer: a missing or extra key fails to compile. */
export type CommandSpecs<C extends { readonly type: string }, S> = {
  readonly [T in C["type"]]: CommandSpec<Extract<C, { readonly type: T }>, S>;
};

/** What an applied event adds to the feed. `who` is not here: labels are resolved when the feed is projected. */
export interface FeedNote {
  readonly kind: string;
  readonly text: string;
  /** The actor the line is labelled with, when not the one who wrote it (the GM giving a hero away). */
  readonly speaker?: string;
}

/** How a feed line of one kind reads: whether it starts with who wrote it, and what comes between. */
export interface FeedFormat {
  /** Narration has no speaker, and a name line names everyone itself. */
  readonly speaker: boolean;
  /** Chat reads "Alice: hi", most else "Alice rolled 14". */
  readonly separator: string;
  /** Label the speaker by name alone, without the hero they play. */
  readonly plainLabel?: boolean;
  /** A glyph shown before the speaker's label: "↶ Oscar undid: …". */
  readonly mark?: string;
}

/** How a kind no module describes reads: "who text". */
const DEFAULT_FORMAT: FeedFormat = { speaker: true, separator: " " };

/** A feed line as the state stores it: the actor id, never their label. */
export interface FeedEntry extends FeedNote {
  readonly seq: number;
  readonly actor: string;
}

/**
 * What one /undo takes back: the retractable events of one submission. The engine stamps every
 * envelope of a submission with one actor and one timestamp, and every submission later than the
 * one before, so a retractable event joins the latest batch when it has the same actor and
 * timestamp and directly follows it; anything else starts a new batch. An event that isn't
 * retractable in the middle of a submission splits its batch in two.
 */
export interface UndoBatch {
  readonly seqs: ReadonlyArray<number>;
  /** Whose change it is: who wrote it, or for a redone change, who wrote it first. */
  readonly actor: string;
  readonly timestamp: string;
  /**
   * The feed text of each of its events, for the line that says what was undone. It is also the
   * batch's result: an undo or redo that folds it again must get the very same lines back.
   */
  readonly undone: ReadonlyArray<string>;
  /**
   * The slices of every module with retractable events, as they were before the batch, with
   * every later event that isn't retractable folded in, so a retraction leaves those standing.
   */
  readonly before: Readonly<Record<string, unknown>>;
  /** Its events as written: folded again when an older batch is taken back, put back by /redo. */
  readonly events: ReadonlyArray<Envelope>;
  /** Whether any of them rolled dice: then only the GM may take it back. */
  readonly rolled: boolean;
  /** Seqs of the submission a lenient reader skipped, which a retraction may also name. */
  readonly loose?: ReadonlyArray<number>;
}

/** What /redo can put back: a batch the latest undos took, and who undid it. */
export interface RedoEntry {
  /** The seqs it had when it was taken back, which `core.redone` names. */
  readonly seqs: ReadonlyArray<number>;
  readonly actor: string;
  readonly by: string;
  readonly events: ReadonlyArray<Envelope>;
  readonly rolled: boolean;
  /** Its feed text when it was taken back: putting it back must read the same. */
  readonly undone: ReadonlyArray<string>;
}

/** The parts of the table state every module shares. */
interface TableBase {
  /** The seq of the last event applied. */
  readonly seq: number;
  /** Every actor who has written an event, in order of their first event. */
  readonly actors: ReadonlyArray<string>;
  /** The last FEED_LIMIT feed entries. */
  readonly feed: ReadonlyArray<FeedEntry>;
  /** The batches /undo can take back, oldest first, at most UNDO_DEPTH. Rebuilt by replay. */
  readonly undo: ReadonlyArray<UndoBatch>;
  /** What /redo can put back, the latest undo last; any new change empties it. */
  readonly redo: ReadonlyArray<RedoEntry>;
}

/** What a module's `decide` may read beyond its own slice. */
export interface Shared {
  readonly actors: ReadonlyArray<string>;
  /** How the table names an actor now, for a refusal: their display name. */
  readonly label: (actor: string) => string;
}

/**
 * A slice of the game: its own state under `key`, its events (namespaced `<key>.<name>`),
 * its commands and the pure decide/apply for them: core and Draw Steel.
 */
export interface Module<K extends string, S, C extends { readonly type: string }> {
  readonly key: K;
  /**
   * The ruleset whose tables offer this module's commands; a module without one (core) is at
   * every table. Its events fold whatever the table plays, so any log replays the same.
   */
  readonly ruleset?: string;
  readonly initial: S;
  readonly events: ReadonlyArray<`${K}.${string}`>;
  /**
   * The events /undo may take back: the game's, never chat, dice, names, seats or claims. A
   * module with any is snapshotted before each batch. Old logs replay by today's list, so
   * changing it is a change to the log contract.
   */
  readonly retractable?: ReadonlyArray<`${K}.${string}`>;
  /**
   * Whether an event carries dice. A batch with one is the GM's alone to take back, so nobody
   * rolls again by undoing; /redo puts it back with the same dice.
   */
  readonly rolled?: (envelope: Envelope) => boolean;
  readonly commands: CommandSpecs<C, S>;
  /** How each feed kind this module writes reads as text. A kind left out reads "who text". */
  readonly formats?: Readonly<Record<string, FeedFormat>>;
  /** Called only for this module's commands, after the GM-only check. */
  readonly decide: (slice: S, shared: Shared, actor: string, command: C, dice: Dice) => Decision;
  /** Called only for this module's events. Throws on an event it can't apply. */
  readonly apply: (slice: S, envelope: Envelope) => { readonly slice: S; readonly feed?: FeedNote };
}

// oxlint-disable-next-line no-explicit-any -- a module list mixes slice and command types
type AnyModule = Module<string, any, any>;

export type StateOf<M extends AnyModule> = TableBase & {
  readonly [X in M as X["key"]]: X["initial"];
};

/**
 * /undo, which compose adds to every table. `now` is the host's clock when the line was sent,
 * filled in by the host: a player's undo is held to a window, and the rules can't read a clock.
 * `who` is the GM's `/undo <who>`, as typed, and `whose` the actor the host found for it.
 */
export type UndoCommand = {
  readonly type: "undo";
  readonly now?: string;
  readonly who?: string;
  readonly whose?: string;
};

/** /redo, which compose adds beside /undo. */
export type RedoCommand = { readonly type: "redo" };

export type CommandOf<M extends AnyModule> =
  | (M extends Module<string, infer _S, infer C> ? C : never)
  | UndoCommand
  | RedoCommand;

/** A command spec in the composed registry, named and reading the whole table state. */
export interface TableCommandSpec<S, C> extends Omit<CommandSpec<C, S>, "complete" | "name"> {
  /** What is typed for it: `/map`. */
  readonly name: string;
  /** Its command's type, which names it to the rules: `map`, or `set-map` for set.world's. */
  readonly type: string;
  /** The ruleset whose tables offer it, or undefined for every table (see `Module.ruleset`). */
  readonly ruleset?: string;
  readonly complete?: (state: S, partial: string, actor: string) => ReadonlyArray<string>;
}

/** What compose may be told about the table beyond its modules. */
export interface ComposeOptions<S> {
  /** How a refusal names an actor ("Bob's …"); without it, by actor id. */
  readonly label?: (state: S, actor: string) => string;
}

export interface Composed<S, C> {
  readonly rules: Rules<S, C>;
  /** Every command of every module, in module order. */
  readonly commands: ReadonlyArray<TableCommandSpec<S, C>>;
  /** How a feed kind reads, from the module that writes it. */
  readonly feedFormat: (kind: string) => FeedFormat;
}

/** Builds one engine `Rules` and one command registry from a list of modules, with /undo. */
export function compose<const Ms extends ReadonlyArray<AnyModule>>(
  modules: Ms,
  options: ComposeOptions<StateOf<Ms[number]>> = {},
): Composed<StateOf<Ms[number]>, CommandOf<Ms[number]>> {
  type S = StateOf<Ms[number]>;
  type C = CommandOf<Ms[number]>;
  const byEvent = new Map<string, AnyModule>();
  const byCommand = new Map<string, { module: AnyModule; spec: TableCommandSpec<S, C> }>();
  const commands: TableCommandSpec<S, C>[] = [];
  const formats = new Map<string, FeedFormat>([
    [UNDO_KIND, UNDO_FORMAT],
    [REDO_KIND, REDO_FORMAT],
  ]);
  const retractable = new Set<string>();
  const snapshotted: AnyModule[] = [];
  const initial: Record<string, unknown> = { seq: 0, actors: [], feed: [], undo: [], redo: [] };

  for (const module of modules) {
    if (module.key in initial) throw new Error(`Two modules claim the state key "${module.key}".`);
    initial[module.key] = module.initial;
    for (const type of module.events) {
      if (!type.startsWith(`${module.key}.`))
        throw new Error(`Event "${type}" is not namespaced under "${module.key}".`);
      if (type === RETRACTED) throw new Error(`"${RETRACTED}" belongs to compose, for /undo.`);
      if (type === REDONE) throw new Error(`"${REDONE}" belongs to compose, for /redo.`);
      if (byEvent.has(type)) throw new Error(`Two modules claim the event "${type}".`);
      byEvent.set(type, module);
    }
    for (const type of module.retractable ?? []) {
      if (byEvent.get(type) !== module)
        throw new Error(`"${type}" is retractable but not one of "${module.key}"'s events.`);
      retractable.add(type);
    }
    if ((module.retractable ?? []).length > 0) snapshotted.push(module);
    for (const [kind, format] of Object.entries(module.formats ?? {})) {
      if (formats.has(kind)) throw new Error(`Two modules describe the feed kind "${kind}".`);
      formats.set(kind, format);
    }
    for (const [type, body] of Object.entries<CommandSpec<C, unknown>>(module.commands)) {
      const { complete, name: typed, ...rest } = body;
      const name = typed ?? type;
      for (const word of [type, name]) {
        if (word === UNDO_SPEC.name) throw new Error("/undo belongs to compose.");
        if (word === REDO_SPEC.name) throw new Error("/redo belongs to compose.");
      }
      if (byCommand.has(type)) throw new Error(`Two modules claim the command "${type}".`);
      // One name for two commands only where no table offers both: each in its own ruleset.
      const twin = commands.find(
        (c) =>
          c.name === name &&
          (c.ruleset === undefined || module.ruleset === undefined || c.ruleset === module.ruleset),
      );
      if (twin !== undefined) throw new Error(`Two commands are typed /${name} at one table.`);
      const named = {
        name,
        type,
        ...rest,
        ...(module.ruleset !== undefined && { ruleset: module.ruleset }),
      };
      const spec: TableCommandSpec<S, C> = complete
        ? {
            ...named,
            complete: (state, partial, actor) => complete(sliceOf(state, module), partial, actor),
          }
        : named;
      byCommand.set(type, { module, spec });
      commands.push(spec);
    }
  }
  commands.push(UNDO_SPEC, REDO_SPEC);

  /** The snapshotted slices as they are now. */
  const snapshot = (state: TableBase): Record<string, unknown> =>
    Object.fromEntries(snapshotted.map((m) => [m.key, sliceOf(state, m)]));

  const rolls = (envelope: Envelope) => byEvent.get(envelope.type)?.rolled?.(envelope) ?? false;

  /** The last seq a batch holds, counting what a lenient reader skipped in it. */
  const lastOf = (batch: UndoBatch) => Math.max(...batch.seqs, ...(batch.loose ?? []));

  /**
   * The stack after a retractable event: it joins the latest batch if it continues that
   * submission, else it opens a new batch with a snapshot of the slices before it.
   */
  const pushed = (state: TableBase, envelope: Envelope, note: FeedNote | undefined) => {
    const top = state.undo.at(-1);
    const undone = note ? [note.text] : [];
    if (
      top !== undefined &&
      top.actor === envelope.actor &&
      top.timestamp === envelope.timestamp &&
      lastOf(top) === state.seq
    ) {
      const joined = {
        ...top,
        seqs: [...top.seqs, envelope.seq],
        undone: [...top.undone, ...undone],
        events: [...top.events, envelope],
        rolled: top.rolled || rolls(envelope),
      };
      return [...state.undo.slice(0, -1), joined];
    }
    const batch: UndoBatch = {
      seqs: [envelope.seq],
      actor: envelope.actor,
      timestamp: envelope.timestamp,
      undone,
      before: snapshot(state),
      events: [envelope],
      rolled: rolls(envelope),
    };
    return [...state.undo, batch].slice(-UNDO_DEPTH);
  };

  /**
   * The stack after an event that isn't retractable changes a snapshotted slice: it is folded
   * into every snapshot, so undo leaves it standing. A snapshot it can't apply to (a claim on a
   * hero the batch brought in) is left as it is: what it depends on isn't there to change.
   */
  const rebased = (stack: ReadonlyArray<UndoBatch>, module: AnyModule, envelope: Envelope) =>
    stack.map((batch) => {
      try {
        const slice = module.apply(batch.before[module.key], envelope).slice;
        return { ...batch, before: { ...batch.before, [module.key]: slice } };
      } catch {
        return batch;
      }
    });

  /** Folds stored events onto snapshotted slices, the way apply would. Throws where one won't go. */
  const refold = (
    slices: Record<string, unknown>,
    events: ReadonlyArray<Envelope>,
  ): { slices: Record<string, unknown>; texts: string[] } => {
    const next = { ...slices };
    const texts: string[] = [];
    for (const e of events) {
      const module = byEvent.get(e.type);
      if (module === undefined || !retractable.has(e.type))
        throw new Error(`"${e.type}" can't be folded again`);
      const applied = module.apply(next[module.key], e);
      next[module.key] = applied.slice;
      if (applied.feed) texts.push(applied.feed.text);
    }
    return { slices: next, texts };
  };

  /**
   * The state with the batch at `index` taken back: the slices from before it, with every later
   * batch folded again on top (each keeping a snapshot of what is now before it). A later batch
   * must come out exactly as it did, the same feed lines, or the feed and the band would disagree
   * and one seat's undo would rewrite another's result; else `changed` names every later batch
   * that wouldn't, up to the first that no longer applies at all.
   */
  const without = (
    state: S,
    index: number,
  ): { restored: S; batch: UndoBatch } | { changed: ReadonlyArray<Changed> } => {
    const batch = state.undo[index]!;
    let slices: Record<string, unknown> = { ...batch.before };
    const kept: UndoBatch[] = state.undo.slice(0, index);
    const changed: Changed[] = [];
    for (const later of state.undo.slice(index + 1)) {
      kept.push({ ...later, before: slices });
      let refolded: ReturnType<typeof refold>;
      try {
        refolded = refold(slices, later.events);
      } catch (e) {
        changed.push({
          batch: later,
          why: e instanceof Error ? e.message : String(e),
          broken: true,
        });
        break;
      }
      const why = difference(later.undone, refolded.texts);
      if (why !== undefined) changed.push({ batch: later, why, broken: false });
      slices = refolded.slices;
    }
    if (changed.length > 0) return { changed };
    return { restored: { ...state, ...slices, undo: kept }, batch };
  };

  /** Names the later changes an undo would change: `Bob's "Brann regains 5 Stamina → 17/24"`. */
  const dependents = (state: S, actor: string, changed: ReadonlyArray<Changed>): string => {
    const label = (who: string) => options.label?.(state, who) ?? who;
    const named = changed.map(({ batch }) =>
      batch.undone.length === 0
        ? `${label(batch.actor)}'s change`
        : `${label(batch.actor)}'s "${joinLines(batch.undone).replace(/\.$/, "")}"`,
    );
    const one = changed.length === 1;
    const head = one ? "A later change depends on it" : "Later changes depend on it";
    const fix = `Undo ${one ? "that" : "those"} first${actor === GM ? "" : ", or ask the GM"}.`;
    return `${head}: ${named.join("; ")}. ${fix}`;
  };

  /** The batch a retraction names: all its seqs, and none but what a lenient reader skipped. */
  const batchNamed = (stack: ReadonlyArray<UndoBatch>, seqs: ReadonlyArray<number>) =>
    stack.findIndex(
      (b) =>
        b.seqs.every((seq) => seqs.includes(seq)) &&
        seqs.every((seq) => b.seqs.includes(seq) || (b.loose ?? []).includes(seq)),
    );

  const decideUndo = (state: S, actor: string, command: UndoCommand): Decision => {
    const stack = state.undo;
    if (stack.length === 0) return { refusal: "Nothing to undo." };
    let index = stack.length - 1;
    if (actor === GM) {
      if (command.who !== undefined) {
        if (command.whose === undefined)
          return { refusal: `Nobody at the table is called '${quote(command.who)}'.` };
        index = stack.findLastIndex((b) => b.actor === command.whose);
        if (index === -1) return { refusal: `${quote(command.who)} has no change left to undo.` };
      }
    } else {
      if (command.whose !== undefined && command.whose !== actor)
        return { refusal: "Only the GM can take back someone else's change." };
      index = stack.findLastIndex((b) => b.actor === actor);
      if (index === -1) return { refusal: "Only the GM can take back someone else's change." };
      const batch = stack[index]!;
      if (batch.rolled)
        return { refusal: "That change rolled dice, so only the GM can take it back." };
      const now = command.now === undefined ? Number.NaN : Date.parse(command.now);
      if (Number.isNaN(now))
        return { refusal: "The host didn't say what time it is, so only the GM can undo." };
      if (now - Date.parse(batch.timestamp) > UNDO_WINDOW_MS)
        return {
          refusal: `Too late: you can take back your own change for ${UNDO_WINDOW_MS / 1000} seconds. Ask the GM.`,
        };
    }
    const taken = without(state, index);
    if ("changed" in taken) return { refusal: dependents(state, actor, taken.changed) };
    const batch = stack[index]!;
    return { events: [{ type: RETRACTED, payload: { seqs: batch.seqs, undone: batch.undone } }] };
  };

  const decideRedo = (state: S, actor: string): Decision => {
    const top = state.redo.at(-1);
    if (top === undefined) return { refusal: "Nothing to redo." };
    if (actor !== GM && top.by !== actor)
      return { refusal: "Only the GM can redo someone else's undo." };
    let same: boolean;
    try {
      same = difference(top.undone, refold(snapshot(state), top.events).texts) === undefined;
    } catch {
      same = false;
    }
    if (!same) return { refusal: "That can't be put back now: the game has changed under it." };
    return { events: [{ type: REDONE, payload: { seqs: top.seqs } }] };
  };

  /**
   * Takes back the batch a retraction names (see `without`); the feed keeps its lines and says
   * so, and /redo can put it back.
   */
  const retract = (state: S, envelope: Envelope): FeedNote & { restored: S } => {
    const { seqs, undone } = decodeRetracted(envelope);
    if (state.undo.length === 0)
      throw new Error(`the retraction at seq ${envelope.seq} has nothing to take back`);
    const index = batchNamed(state.undo, seqs);
    if (index === -1)
      throw new Error(
        `the retraction at seq ${envelope.seq} names no batch that can be undone (seq ${seqs.join(", ")})`,
      );
    if (undone.some(hasTerminalControls))
      throw new Error(`unsafe text in the retraction at seq ${envelope.seq}`);
    const taken = without(state, index);
    if ("changed" in taken) {
      const first = taken.changed[0]!;
      throw new Error(
        first.broken
          ? `the retraction at seq ${envelope.seq} would break a later change: ${first.why}`
          : `the retraction at seq ${envelope.seq} would change a later change at seq ${first.batch.seqs[0]}: ${first.why}`,
      );
    }
    const { restored, batch } = taken;
    const entry: RedoEntry = {
      seqs: batch.seqs,
      actor: batch.actor,
      by: envelope.actor,
      events: batch.events,
      rolled: batch.rolled,
      undone: batch.undone,
    };
    return {
      kind: UNDO_KIND,
      text: undone.length === 0 ? "undid the last change." : `undid: ${joinLines(undone)}`,
      restored: { ...restored, redo: [...state.redo, entry].slice(-UNDO_DEPTH) },
    };
  };

  /** Puts back the batch the latest undo took, as a new batch whose events are the same ones. */
  const putBack = (state: S, envelope: Envelope): FeedNote & { restored: S } => {
    const { seqs } = decodeRedone(envelope);
    const top = state.redo.at(-1);
    if (
      top === undefined ||
      top.seqs.length !== seqs.length ||
      top.seqs.some((s, i) => s !== seqs[i])
    )
      throw new Error(`the redo at seq ${envelope.seq} isn't of the latest undo`);
    const { slices, texts } = refold(snapshot(state), top.events);
    const why = difference(top.undone, texts);
    if (why !== undefined)
      throw new Error(`the redo at seq ${envelope.seq} would come out differently: ${why}`);
    const batch: UndoBatch = {
      seqs: [envelope.seq],
      actor: top.actor,
      timestamp: envelope.timestamp,
      undone: texts,
      before: snapshot(state),
      events: top.events,
      rolled: top.rolled,
    };
    return {
      kind: REDO_KIND,
      text: texts.length === 0 ? "redid the last change." : `redid: ${joinLines(texts)}`,
      restored: {
        ...state,
        ...slices,
        undo: [...state.undo, batch].slice(-UNDO_DEPTH),
        redo: state.redo.slice(0, -1),
      },
    };
  };

  const rules: Rules<S, C> = {
    initial: initial as S,
    knows: (type) => type === RETRACTED || type === REDONE || byEvent.has(type),
    decide: (state, actor, command, dice) => {
      const { type } = command as { readonly type: string };
      if (type === UNDO_SPEC.name) return decideUndo(state, actor, command as UndoCommand);
      if (type === REDO_SPEC.name) return decideRedo(state, actor);
      const entry = byCommand.get(type);
      if (!entry) return { refusal: `There is no "${type}" command.` };
      if (entry.spec.gmOnly && actor !== GM)
        return { refusal: `Only the GM can use /${entry.spec.name}.` };
      return entry.module.decide(
        sliceOf(state, entry.module),
        { actors: state.actors, label: (who) => options.label?.(state, who) ?? who },
        actor,
        command,
        dice,
      );
    },
    apply: (state, envelope) => {
      const module = byEvent.get(envelope.type);
      if (!module && envelope.type !== RETRACTED && envelope.type !== REDONE)
        throw new Error(`unknown event type "${envelope.type}"`);
      if (!Number.isInteger(envelope.seq) || envelope.seq <= state.seq)
        throw new Error(`seq ${envelope.seq} does not follow seq ${state.seq}`);
      let next: S;
      let feed: FeedNote | undefined;
      if (!module) {
        const { restored, ...note } =
          envelope.type === RETRACTED ? retract(state, envelope) : putBack(state, envelope);
        next = restored;
        feed = note;
      } else {
        const before = sliceOf(state, module);
        const applied = module.apply(before, envelope);
        feed = applied.feed;
        let undo = state.undo;
        let redo = state.redo;
        if (retractable.has(envelope.type)) {
          undo = pushed(state, envelope, feed);
          redo = [];
        } else if (snapshotted.includes(module) && applied.slice !== before) {
          // An event that changes nothing (a measurement) needn't be folded into the snapshots.
          undo = rebased(state.undo, module, envelope);
        }
        next = { ...state, undo, redo, [module.key]: applied.slice };
      }
      const actors = state.actors.includes(envelope.actor)
        ? state.actors
        : [...state.actors, envelope.actor];
      const entries = feed
        ? [
            ...state.feed,
            {
              seq: envelope.seq,
              actor: envelope.actor,
              kind: feed.kind,
              text: feed.text,
              ...(feed.speaker !== undefined && { speaker: feed.speaker }),
            },
          ].slice(-FEED_LIMIT)
        : state.feed;
      return { ...next, seq: envelope.seq, actors, feed: entries };
    },
    // A lenient reader skipped an event it doesn't know: a later retraction may name it, so the
    // batch it would have joined remembers its seq.
    skip: (state, envelope) => {
      const top = state.undo.at(-1);
      const joins =
        top !== undefined &&
        top.actor === envelope.actor &&
        top.timestamp === envelope.timestamp &&
        lastOf(top) === state.seq;
      const undo = joins
        ? [...state.undo.slice(0, -1), { ...top, loose: [...(top.loose ?? []), envelope.seq] }]
        : state.undo;
      return { ...state, undo, seq: Math.max(state.seq, envelope.seq) };
    },
  };
  return { rules, commands, feedFormat: (kind) => formats.get(kind) ?? DEFAULT_FORMAT };
}

/** A later batch an undo would change, and how. */
interface Changed {
  readonly batch: UndoBatch;
  readonly why: string;
  /** It wouldn't apply at all, rather than read differently. */
  readonly broken: boolean;
}

/** How a batch's feed lines, folded again, differ from what they were; undefined when they don't. */
function difference(was: ReadonlyArray<string>, now: ReadonlyArray<string>): string | undefined {
  const at = Array.from({ length: Math.max(was.length, now.length) }, (_, i) => i).find(
    (i) => was[i] !== now[i],
  );
  if (at === undefined) return undefined;
  const line = (text: string | undefined) => (text === undefined ? "nothing" : `"${text}"`);
  return `${line(was[at])} would read ${line(now[at])}`;
}

const sliceOf = (state: TableBase, module: AnyModule): unknown =>
  (state as unknown as Record<string, unknown>)[module.key];

/** The feed kind of the line a retraction writes: "↶ Oscar undid: Vex takes 14 damage …". */
const UNDO_KIND = "undo";
const UNDO_FORMAT: FeedFormat = { speaker: true, separator: " ", mark: "↶" };
/** The line /redo writes: "↷ Oscar redid: Vex takes 14 damage …". */
const REDO_KIND = "redo";
const REDO_FORMAT: FeedFormat = { speaker: true, separator: " ", mark: "↷" };

/** Feed lines run together: "Kor's turn ends; Vex's turn." with no full stop before a semicolon. */
const joinLines = (lines: ReadonlyArray<string>): string =>
  lines.map((line, i) => (i < lines.length - 1 ? line.replace(/\.$/, "") : line)).join("; ");

const UNDO_SPEC = {
  name: "undo",
  type: "undo",
  usage: "/undo [who]",
  summary: "Take back your latest change within 30 s, unless it rolled; the GM, anyone's.",
  gmOnly: false,
  parse: (args: string): UndoCommand | Refused => {
    const who = args.trim();
    if (who === "") return { type: "undo" };
    return /\s/.test(who) ? { refusal: "Usage: /undo [who]" } : { type: "undo", who };
  },
} as const;

const REDO_SPEC = {
  name: "redo",
  type: "redo",
  usage: "/redo",
  summary: "Put back what the latest /undo took, with the same dice.",
  gmOnly: false,
  parse: (args: string): RedoCommand | Refused =>
    args.trim() === "" ? { type: "redo" } : { refusal: "Usage: /redo" },
} as const;

const Retracted = Schema.Struct({
  seqs: Schema.NonEmptyArray(Schema.Int),
  undone: Schema.Array(Schema.String),
});

const Redone = Schema.Struct({ seqs: Schema.NonEmptyArray(Schema.Int) });

function decodeRedone(envelope: Envelope): typeof Redone.Type {
  try {
    return Schema.decodeUnknownSync(Redone)(envelope.payload);
  } catch (e) {
    throw new Error(
      `bad ${envelope.type} payload at seq ${envelope.seq}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function decodeRetracted(envelope: Envelope): typeof Retracted.Type {
  try {
    return Schema.decodeUnknownSync(Retracted)(envelope.payload);
  } catch (e) {
    throw new Error(
      `bad ${envelope.type} payload at seq ${envelope.seq}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
