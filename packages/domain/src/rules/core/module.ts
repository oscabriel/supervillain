import type { Decision, Dice, Envelope, Refused } from "../engine.ts";

export const GM = "gm";

export const FEED_LIMIT = 500;

export const UNDO_DEPTH = 20;

export const UNDO_WINDOW_MS = 30_000;

export const RETRACTED = "core.retracted";

export const REDONE = "core.redone";

export interface CommandSpec<C, S> {
	readonly usage: string;
	readonly summary: string;
	readonly gmOnly: boolean;
	readonly name?: string;
	readonly parse: (args: string) => C | Refused;
	readonly complete?: (
		slice: S,
		partial: string,
		actor: string
	) => ReadonlyArray<string>;
}

export type CommandSpecs<C extends { readonly type: string }, S> = {
	readonly [T in C["type"]]: CommandSpec<Extract<C, { readonly type: T }>, S>;
};

export interface FeedNote {
	readonly kind: string;
	readonly text: string;
	readonly speaker?: string;
}

export interface FeedFormat {
	readonly speaker: boolean;
	readonly separator: string;
	readonly plainLabel?: boolean;
	readonly mark?: string;
}

export const DEFAULT_FORMAT: FeedFormat = { speaker: true, separator: " " };

export interface FeedEntry extends FeedNote {
	readonly seq: number;
	readonly actor: string;
}

export interface Shared {
	readonly actors: ReadonlyArray<string>;
	readonly label: (actor: string) => string;
	readonly now: number;
}

export interface Applied<S> {
	readonly slice: S;
	readonly feed?: FeedNote;
}

export interface Module<
	K extends string,
	S,
	C extends { readonly type: string },
> {
	readonly key: K;
	readonly ruleset?: string;
	readonly initial: S;
	readonly events: ReadonlyArray<`${K}.${string}`>;
	readonly retractable: ReadonlyArray<`${K}.${string}`>;
	readonly rolled: (envelope: Envelope) => boolean;
	readonly commands: CommandSpecs<C, S>;
	readonly formats: Readonly<Record<string, FeedFormat>>;
	readonly decide: (
		slice: S,
		shared: Shared,
		actor: string,
		command: C,
		dice: Dice
	) => Decision;
	readonly apply: (slice: S, envelope: Envelope) => Applied<S>;
}

export interface TableCommandSpec<S, C> {
	readonly name: string;
	readonly type: string;
	readonly usage: string;
	readonly summary: string;
	readonly gmOnly: boolean;
	readonly ruleset?: string;
	readonly parse: (args: string) => C | Refused;
	readonly complete?: (
		state: S,
		partial: string,
		actor: string
	) => ReadonlyArray<string>;
}

export interface UndoCommand {
	readonly type: "undo";
	readonly who?: string;
	readonly whose?: string;
}

export interface RedoCommand {
	readonly type: "redo";
}

export interface UndoBatchOf<Sl> {
	readonly seqs: ReadonlyArray<number>;
	readonly actor: string;
	readonly timestamp: string;
	readonly undone: ReadonlyArray<string>;
	readonly before: Sl;
	readonly events: ReadonlyArray<Envelope>;
	readonly after: ReadonlyArray<Envelope>;
	readonly rolled: boolean;
	readonly loose?: ReadonlyArray<number>;
}

export interface RedoEntryOf<Sl> {
	readonly seqs: ReadonlyArray<number>;
	readonly actor: string;
	readonly by: string;
	readonly events: ReadonlyArray<Envelope>;
	readonly after: ReadonlyArray<Envelope>;
	readonly rolled: boolean;
	readonly undone: ReadonlyArray<string>;
	readonly left?: Sl;
}

export interface TableBase<Sl> {
	readonly seq: number;
	readonly actors: ReadonlyArray<string>;
	readonly feed: ReadonlyArray<FeedEntry>;
	readonly undo: ReadonlyArray<UndoBatchOf<Sl>>;
	readonly redo: ReadonlyArray<RedoEntryOf<Sl>>;
}
