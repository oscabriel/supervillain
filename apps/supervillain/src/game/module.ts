import type { Decision, Dice, Envelope, Rules } from "@supervillain/engine";

/** The GM's local seat. The only actor that may run a GM-only command. */
export const GM = "gm";

/** How many feed lines the state keeps. Names live elsewhere, so labels never depend on this cap. */
export const FEED_LIMIT = 500;

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
}

/** How a kind no module describes reads: "who text". */
const DEFAULT_FORMAT: FeedFormat = { speaker: true, separator: " " };

/** A feed line as the state stores it: the actor id, never their label. */
export interface FeedEntry extends FeedNote {
  readonly seq: number;
  readonly actor: string;
}

/** The parts of the table state every module shares. */
export interface TableBase {
  /** The seq of the last event applied. */
  readonly seq: number;
  /** Every actor who has written an event, in order of their first event. */
  readonly actors: ReadonlyArray<string>;
  /** The last FEED_LIMIT feed entries. */
  readonly feed: ReadonlyArray<FeedEntry>;
}

/** What a module's `decide` may read beyond its own slice. */
export interface Shared {
  readonly actors: ReadonlyArray<string>;
}

/**
 * A slice of the game: its own state under `key`, its events (namespaced `<key>.<name>`),
 * its commands and the pure decide/apply for them. Draw Steel will be the second one.
 */
export interface Module<K extends string, S, C extends { readonly type: string }> {
  readonly key: K;
  readonly initial: S;
  readonly events: ReadonlyArray<`${K}.${string}`>;
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

export type CommandOf<M extends AnyModule> =
  M extends Module<string, infer _S, infer C> ? C : never;

/** A command spec in the composed registry, named and reading the whole table state. */
export interface TableCommandSpec<S, C> extends Omit<CommandSpec<C, S>, "complete"> {
  readonly name: string;
  readonly complete?: (state: S, partial: string, actor: string) => ReadonlyArray<string>;
}

export interface Composed<S, C> {
  readonly rules: Rules<S, C>;
  /** Every command of every module, in module order. */
  readonly commands: ReadonlyArray<TableCommandSpec<S, C>>;
  /** How a feed kind reads, from the module that writes it. */
  readonly feedFormat: (kind: string) => FeedFormat;
}

/** Builds one engine `Rules` and one command registry from a list of modules. */
export function compose<const Ms extends ReadonlyArray<AnyModule>>(
  modules: Ms,
): Composed<StateOf<Ms[number]>, CommandOf<Ms[number]>> {
  type S = StateOf<Ms[number]>;
  type C = CommandOf<Ms[number]>;
  const byEvent = new Map<string, AnyModule>();
  const byCommand = new Map<string, { module: AnyModule; spec: TableCommandSpec<S, C> }>();
  const commands: TableCommandSpec<S, C>[] = [];
  const formats = new Map<string, FeedFormat>();
  const initial: Record<string, unknown> = { seq: 0, actors: [], feed: [] };

  for (const module of modules) {
    if (module.key in initial) throw new Error(`Two modules claim the state key "${module.key}".`);
    initial[module.key] = module.initial;
    for (const type of module.events) {
      if (!type.startsWith(`${module.key}.`))
        throw new Error(`Event "${type}" is not namespaced under "${module.key}".`);
      if (byEvent.has(type)) throw new Error(`Two modules claim the event "${type}".`);
      byEvent.set(type, module);
    }
    for (const [kind, format] of Object.entries(module.formats ?? {})) {
      if (formats.has(kind)) throw new Error(`Two modules describe the feed kind "${kind}".`);
      formats.set(kind, format);
    }
    for (const [name, body] of Object.entries<CommandSpec<C, unknown>>(module.commands)) {
      if (byCommand.has(name)) throw new Error(`Two modules claim the command "${name}".`);
      const { complete, ...rest } = body;
      const spec: TableCommandSpec<S, C> = complete
        ? {
            name,
            ...rest,
            complete: (state, partial, actor) => complete(sliceOf(state, module), partial, actor),
          }
        : { name, ...rest };
      byCommand.set(name, { module, spec });
      commands.push(spec);
    }
  }

  const rules: Rules<S, C> = {
    initial: initial as S,
    knows: (type) => byEvent.has(type),
    decide: (state, actor, command, dice) => {
      const entry = byCommand.get(command.type);
      if (!entry) return { refusal: `There is no "${command.type}" command.` };
      if (entry.spec.gmOnly && actor !== GM)
        return { refusal: `Only the GM can use /${entry.spec.name}.` };
      return entry.module.decide(
        sliceOf(state, entry.module),
        { actors: state.actors },
        actor,
        command,
        dice,
      );
    },
    apply: (state, envelope) => {
      const module = byEvent.get(envelope.type);
      if (!module) throw new Error(`unknown event type "${envelope.type}"`);
      if (!Number.isInteger(envelope.seq) || envelope.seq <= state.seq)
        throw new Error(`seq ${envelope.seq} does not follow seq ${state.seq}`);
      const { slice, feed } = module.apply(sliceOf(state, module), envelope);
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
      return { ...state, seq: envelope.seq, actors, feed: entries, [module.key]: slice };
    },
  };
  return { rules, commands, feedFormat: (kind) => formats.get(kind) ?? DEFAULT_FORMAT };
}

const sliceOf = (state: TableBase, module: AnyModule): unknown =>
  (state as unknown as Record<string, unknown>)[module.key];
