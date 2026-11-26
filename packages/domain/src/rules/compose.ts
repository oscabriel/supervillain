import { DateTime, Option } from "effect";

import { orEmpty } from "../present.ts";
import { hasTerminalControls, quote } from "../text.ts";
import { core, CorePayloads, isMember, labelOf } from "./core/core.ts";
import type { CoreCommand, CoreState } from "./core/core.ts";
import {
	DEFAULT_FORMAT,
	FEED_LIMIT,
	GM,
	REDONE,
	RETRACTED,
	UNDO_DEPTH,
	UNDO_WINDOW_MS,
} from "./core/module.ts";
import type {
	CommandSpec,
	FeedEntry,
	FeedFormat,
	FeedNote,
	RedoCommand,
	RedoEntryOf,
	Shared,
	TableBase,
	TableCommandSpec,
	UndoBatchOf,
	UndoCommand,
} from "./core/module.ts";
import {
	afterCombat,
	applyStage,
	decideStage,
	initialStage,
	isStageCommandType,
	STAGE_EVENTS as STAGE_EVENT_TYPES,
	stageCommands,
	stageFormats,
} from "./core/stage.ts";
import type { StageCommand, StageState } from "./core/stage.ts";
import { drawSteel } from "./drawSteel/index.ts";
import type { DsCommand } from "./drawSteel/index.ts";
import type { DrawSteelState } from "./drawSteel/state.ts";
import { decodePayload, isRefused, messageOf, refuse } from "./engine.ts";
import type { Decision, Dice, Envelope, Refused, Rules } from "./engine.ts";
import type { FfCommand } from "./freeform/commands.ts";
import { freeform } from "./freeform/index.ts";
import type { FfState } from "./freeform/state.ts";
import type { PfCommand } from "./pf2e/commands.ts";
import { pf2e } from "./pf2e/index.ts";
import type { PfState } from "./pf2e/state.ts";
import type { SetCommand } from "./setWorld/commands.ts";
import { setWorld } from "./setWorld/index.ts";
import type { SetState } from "./setWorld/state.ts";

export interface Slices {
	readonly ds: DrawSteelState;
	readonly sw: SetState;
	readonly pf: PfState;
	readonly ff: FfState;
}

export type UndoBatch = UndoBatchOf<Slices>;

export type RedoEntry = RedoEntryOf<Slices>;

export interface TableState extends TableBase<Slices> {
	readonly core: CoreState;
	readonly ds: DrawSteelState;
	readonly sw: SetState;
	readonly pf: PfState;
	readonly ff: FfState;
	readonly stage: StageState;
}

export type Command =
	| CoreCommand
	| DsCommand
	| SetCommand
	| PfCommand
	| FfCommand
	| StageCommand
	| UndoCommand
	| RedoCommand;

export type TableSpec = TableCommandSpec<TableState, Command>;

const UNDO_KIND = "undo";

const REDO_KIND = "redo";

const UNDO_FORMAT: FeedFormat = { speaker: true, separator: " ", mark: "↶" };

const REDO_FORMAT: FeedFormat = { speaker: true, separator: " ", mark: "↷" };

const FULL_STOP = /\.$/u;

const SPACE = /\s/u;

const Retracted = CorePayloads["core.retracted"];

const Redone = CorePayloads["core.redone"];

const CORE_EVENTS: ReadonlySet<string> = new Set(core.events);

const DS_EVENTS: ReadonlySet<string> = new Set(drawSteel.events);

const SW_EVENTS: ReadonlySet<string> = new Set(setWorld.events);

const PF_EVENTS: ReadonlySet<string> = new Set(pf2e.events);

const FF_EVENTS: ReadonlySet<string> = new Set(freeform.events);

const STAGE_EVENTS: ReadonlySet<string> = new Set(STAGE_EVENT_TYPES);

const RETRACTABLE: ReadonlySet<string> = new Set([
	...drawSteel.retractable,
	...setWorld.retractable,
	...pf2e.retractable,
	...freeform.retractable,
]);

export const isCoreCommand = (command: Command): command is CoreCommand =>
	Object.hasOwn(core.commands, command.type);

export const isDsCommand = (command: Command): command is DsCommand =>
	Object.hasOwn(drawSteel.commands, command.type);

export const isSetCommand = (command: Command): command is SetCommand =>
	Object.hasOwn(setWorld.commands, command.type);

export const isPfCommand = (command: Command): command is PfCommand =>
	Object.hasOwn(pf2e.commands, command.type);

export const isFfCommand = (command: Command): command is FfCommand =>
	Object.hasOwn(freeform.commands, command.type);

export const isStageCommand = (command: Command): command is StageCommand =>
	isStageCommandType(command.type);

export const inCombatAny = (slices: Slices): boolean =>
	slices.ds.combat.active ||
	slices.sw.fight !== undefined ||
	slices.pf.combat !== undefined ||
	slices.ff.order !== undefined;

const joinLines = (lines: ReadonlyArray<string>): string =>
	lines
		.map((line, i) =>
			i < lines.length - 1 ? line.replace(FULL_STOP, "") : line
		)
		.join("; ");

const UNDO_SPEC: TableSpec = {
	name: "undo",
	type: "undo",
	usage: "/undo [who]",
	summary:
		"Take back your latest change within 30 s, unless it rolled; the GM, anyone's.",
	gmOnly: false,
	parse: (args) => {
		const who = args.trim();

		if (who === "") {
			return { type: "undo" };
		}

		return SPACE.test(who)
			? { refusal: "Usage: /undo [who]" }
			: { type: "undo", who };
	},
};

const REDO_SPEC: TableSpec = {
	name: "redo",
	type: "redo",
	usage: "/redo",
	summary: "Put back what the latest /undo took, with the same dice.",
	gmOnly: false,
	parse: (args) =>
		args.trim() === "" ? { type: "redo" } : { refusal: "Usage: /redo" },
};

const specsOf = <S, C extends Command>(
	specs: Readonly<Record<string, CommandSpec<C, S>>>,
	slice: (state: TableState) => S,
	ruleset: string | undefined
): Array<TableSpec> =>
	Object.entries(specs).map(([type, spec]): TableSpec => {
		const { complete } = spec;

		const named: TableSpec = {
			name: spec.name ?? type,
			type,
			usage: spec.usage,
			summary: spec.summary,
			gmOnly: spec.gmOnly,
			parse: spec.parse,
		};

		const ruled: TableSpec =
			ruleset === undefined ? named : { ...named, ruleset };

		return complete === undefined
			? ruled
			: {
					...ruled,
					complete: (state, partial, actor) =>
						complete(slice(state), partial, actor),
				};
	});

export const commands: ReadonlyArray<TableSpec> = [
	...specsOf<CoreState, CoreCommand>(
		core.commands,
		(state) => state.core,
		core.ruleset
	),
	...specsOf<DrawSteelState, DsCommand>(
		drawSteel.commands,
		(state) => state.ds,
		drawSteel.ruleset
	),
	...specsOf<SetState, SetCommand>(
		setWorld.commands,
		(state) => state.sw,
		setWorld.ruleset
	),
	...specsOf<PfState, PfCommand>(
		pf2e.commands,
		(state) => state.pf,
		pf2e.ruleset
	),
	...specsOf<FfState, FfCommand>(
		freeform.commands,
		(state) => state.ff,
		freeform.ruleset
	),
	...specsOf<StageState, StageCommand>(
		stageCommands,
		(state) => state.stage,
		undefined
	),
	UNDO_SPEC,
	REDO_SPEC,
];

const BY_TYPE: ReadonlyMap<string, TableSpec> = new Map(
	commands.map((spec) => [spec.type, spec])
);

const FORMATS: ReadonlyMap<string, FeedFormat> = new Map([
	[UNDO_KIND, UNDO_FORMAT],
	[REDO_KIND, REDO_FORMAT],
	...Object.entries(core.formats),
	...Object.entries(drawSteel.formats),
	...Object.entries(setWorld.formats),
	...Object.entries(pf2e.formats),
	...Object.entries(freeform.formats),
	...Object.entries(stageFormats),
]);

export const feedFormat = (kind: string): FeedFormat =>
	FORMATS.get(kind) ?? DEFAULT_FORMAT;

const snapshot = (state: TableState): Slices => ({
	ds: state.ds,
	sw: state.sw,
	pf: state.pf,
	ff: state.ff,
});

const rolls = (envelope: Envelope): boolean => {
	if (DS_EVENTS.has(envelope.type)) {
		return drawSteel.rolled(envelope);
	}

	if (SW_EVENTS.has(envelope.type)) {
		return setWorld.rolled(envelope);
	}

	if (FF_EVENTS.has(envelope.type)) {
		return freeform.rolled(envelope);
	}

	return PF_EVENTS.has(envelope.type) && pf2e.rolled(envelope);
};

interface SliceApplied {
	readonly slices: Slices;
	readonly feed: FeedNote | undefined;
	readonly changed: boolean;
}

const applySlice = (slices: Slices, envelope: Envelope): SliceApplied => {
	if (DS_EVENTS.has(envelope.type)) {
		const applied = drawSteel.apply(slices.ds, envelope);

		return {
			slices: { ...slices, ds: applied.slice },
			feed: applied.feed,
			changed: applied.slice !== slices.ds,
		};
	}

	if (SW_EVENTS.has(envelope.type)) {
		const applied = setWorld.apply(slices.sw, envelope);

		return {
			slices: { ...slices, sw: applied.slice },
			feed: applied.feed,
			changed: applied.slice !== slices.sw,
		};
	}

	if (PF_EVENTS.has(envelope.type)) {
		const applied = pf2e.apply(slices.pf, envelope);

		return {
			slices: { ...slices, pf: applied.slice },
			feed: applied.feed,
			changed: applied.slice !== slices.pf,
		};
	}

	if (FF_EVENTS.has(envelope.type)) {
		const applied = freeform.apply(slices.ff, envelope);

		return {
			slices: { ...slices, ff: applied.slice },
			feed: applied.feed,
			changed: applied.slice !== slices.ff,
		};
	}

	throw new Error(`no ruleset folds "${envelope.type}"`);
};

const lastOf = (batch: UndoBatch): number =>
	Math.max(...batch.seqs, ...orEmpty(batch.loose));

const opened = (state: TableState, envelope: Envelope): UndoBatch => ({
	seqs: [envelope.seq],
	actor: envelope.actor,
	timestamp: envelope.timestamp,
	undone: [],
	before: snapshot(state),
	events: [envelope],
	after: [],
	rolled: rolls(envelope),
});

const continues = (
	top: UndoBatch | undefined,
	state: TableState,
	envelope: Envelope
): top is UndoBatch =>
	top !== undefined &&
	top.actor === envelope.actor &&
	top.timestamp === envelope.timestamp &&
	lastOf(top) === state.seq;

const pushed = (
	state: TableState,
	envelope: Envelope,
	note: FeedNote | undefined
): ReadonlyArray<UndoBatch> => {
	const top = state.undo.at(-1);
	const undone = note === undefined ? [] : [note.text];

	if (continues(top, state, envelope)) {
		const joined: UndoBatch = {
			...top,
			seqs: [...top.seqs, envelope.seq],
			undone: [...top.undone, ...undone],
			events: [...top.events, envelope],
			rolled: top.rolled || rolls(envelope),
		};

		return [...state.undo.slice(0, -1), joined];
	}

	return [...state.undo, { ...opened(state, envelope), undone }].slice(
		-UNDO_DEPTH
	);
};

interface Refolded {
	readonly slices: Slices;
	readonly texts: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<Envelope>;
}

const refold = (slices: Slices, events: ReadonlyArray<Envelope>): Refolded => {
	let next = slices;
	const texts: Array<string> = [];
	const skipped: Array<Envelope> = [];

	for (const e of events) {
		try {
			const applied = applySlice(next, e);

			next = applied.slices;

			if (applied.feed !== undefined && RETRACTABLE.has(e.type)) {
				texts.push(applied.feed.text);
			}
		} catch (error) {
			if (RETRACTABLE.has(e.type)) {
				throw error;
			}

			skipped.push(e);
		}
	}

	return { slices: next, texts, skipped };
};

interface Changed {
	readonly batch: UndoBatch;
	readonly why: string;
	readonly broken: boolean;
}

const lineOf = (text: string | undefined): string =>
	text === undefined ? "nothing" : `"${text}"`;

const difference = (
	was: ReadonlyArray<string>,
	now: ReadonlyArray<string>
): string | undefined => {
	const at = Array.from(
		{ length: Math.max(was.length, now.length) },
		(_, i) => i
	).find((i) => was[i] !== now[i]);

	if (at === undefined) {
		return undefined;
	}

	return `${lineOf(was[at])} would read ${lineOf(now[at])}`;
};

type Without =
	| {
			readonly restored: TableState;
			readonly skipped: ReadonlyArray<Envelope>;
	  }
	| { readonly changed: ReadonlyArray<Changed> };

const without = (
	state: TableState,
	index: number,
	batch: UndoBatch
): Without => {
	const first = refold(batch.before, batch.after);
	let { slices } = first;
	const skipped: Array<Envelope> = [...first.skipped];
	const kept: Array<UndoBatch> = state.undo.slice(0, index);

	const standing = (events: ReadonlyArray<Envelope>) =>
		events.filter((e) => !skipped.includes(e));

	const previous = kept.pop();

	if (previous !== undefined) {
		kept.push({
			...previous,
			after: [...previous.after, ...standing(batch.after)],
		});
	}

	const changed: Array<Changed> = [];

	for (const later of state.undo.slice(index + 1)) {
		let refolded: Refolded;

		try {
			refolded = refold(slices, [...later.events, ...later.after]);
		} catch (error) {
			changed.push({ batch: later, why: messageOf(error), broken: true });
			break;
		}

		const why = difference(later.undone, refolded.texts);

		if (why !== undefined) {
			changed.push({ batch: later, why, broken: false });
		}

		skipped.push(...refolded.skipped);
		kept.push({ ...later, before: slices, after: standing(later.after) });
		({ slices } = refolded);
	}

	if (changed.length > 0) {
		return { changed };
	}

	return { restored: { ...state, ...slices, undo: kept }, skipped };
};

const label = (state: TableState, actor: string): string =>
	labelOf(state)(actor);

const dependents = (
	state: TableState,
	actor: string,
	changed: ReadonlyArray<Changed>
): string => {
	const named = changed.map(({ batch }) =>
		batch.undone.length === 0
			? `${label(state, batch.actor)}'s change`
			: `${label(state, batch.actor)}'s "${joinLines(batch.undone).replace(FULL_STOP, "")}"`
	);

	const one = changed.length === 1;

	const head = one
		? "A later change depends on it"
		: "Later changes depend on it";

	const fix = `Undo ${one ? "that" : "those"} first${actor === GM ? "" : ", or ask the GM"}.`;

	return `${head}: ${named.join("; ")}. ${fix}`;
};

const batchNamed = (
	stack: ReadonlyArray<UndoBatch>,
	seqs: ReadonlyArray<number>
): number =>
	stack.findIndex(
		(b) =>
			b.seqs.every((seq) => seqs.includes(seq)) &&
			seqs.every((seq) => b.seqs.includes(seq) || (b.loose ?? []).includes(seq))
	);

const millisOf = (timestamp: string, fallback: number): number =>
	Option.getOrElse(
		Option.map(DateTime.make(timestamp), DateTime.toEpochMillis),
		() => fallback
	);

const undoIndex = (
	state: TableState,
	actor: string,
	command: UndoCommand,
	now: number
): number | Refused => {
	const stack = state.undo;

	if (actor === GM) {
		if (command.who === undefined) {
			return stack.length - 1;
		}

		const index = stack.findLastIndex((b) => b.actor === command.whose);

		return index === -1
			? refuse(`${quote(command.who)} has no change left to undo.`)
			: index;
	}

	if (command.whose !== undefined && command.whose !== actor) {
		return refuse("Only the GM can take back someone else's change.");
	}

	const index = stack.findLastIndex((b) => b.actor === actor);
	const batch = stack[index];

	if (batch === undefined) {
		return refuse("Only the GM can take back someone else's change.");
	}

	if (batch.rolled) {
		return refuse("That change rolled dice, so only the GM can take it back.");
	}

	if (now - millisOf(batch.timestamp, now) > UNDO_WINDOW_MS) {
		return refuse(
			`Too late: you can take back your own change for ${UNDO_WINDOW_MS / 1000} seconds. Ask the GM.`
		);
	}

	return index;
};

const decideUndo = (
	state: TableState,
	actor: string,
	command: UndoCommand,
	now: number
): Decision => {
	if (state.undo.length === 0) {
		return refuse("Nothing to undo.");
	}

	if (command.who !== undefined && command.whose === undefined) {
		return refuse(`Nobody at the table is called '${quote(command.who)}'.`);
	}

	const index = undoIndex(state, actor, command, now);

	if (isRefused(index)) {
		return index;
	}

	const batch = state.undo[index];

	if (batch === undefined) {
		return refuse("Nothing to undo.");
	}

	const taken = without(state, index, batch);

	if ("changed" in taken) {
		return refuse(dependents(state, actor, taken.changed));
	}

	return {
		events: [
			{
				type: RETRACTED,
				payload: { seqs: batch.seqs, undone: batch.undone },
			},
		],
	};
};

const sameAs = (state: TableState, top: RedoEntry): boolean => {
	try {
		return (
			top.left !== undefined &&
			JSON.stringify(snapshot(state)) === JSON.stringify(top.left) &&
			difference(top.undone, refold(snapshot(state), top.events).texts) ===
				undefined
		);
	} catch {
		return false;
	}
};

const decideRedo = (state: TableState, actor: string): Decision => {
	const top = state.redo.at(-1);

	if (top === undefined) {
		return refuse("Nothing to redo.");
	}

	if (actor !== GM && top.by !== actor) {
		return refuse("Only the GM can redo someone else's undo.");
	}

	if (!sameAs(state, top)) {
		return refuse("That can't be put back now: the game has changed under it.");
	}

	return { events: [{ type: REDONE, payload: { seqs: top.seqs } }] };
};

interface Restored {
	readonly note: FeedNote;
	readonly restored: TableState;
}

interface RetractionTarget {
	readonly index: number;
	readonly batch: UndoBatch;
}

const retractionTarget = (
	state: TableState,
	envelope: Envelope,
	seqs: ReadonlyArray<number>
): RetractionTarget => {
	if (state.undo.length === 0) {
		throw new Error(
			`the retraction at seq ${envelope.seq} has nothing to take back`
		);
	}

	const index = batchNamed(state.undo, seqs);
	const batch = state.undo[index];

	if (batch === undefined) {
		throw new Error(
			`the retraction at seq ${envelope.seq} names no batch that can be undone (seq ${seqs.join(", ")})`
		);
	}

	return { index, batch };
};

const brokenBy = (envelope: Envelope, first: Changed | undefined): string => {
	if (first === undefined) {
		return `the retraction at seq ${envelope.seq} would change a later change`;
	}

	return first.broken
		? `the retraction at seq ${envelope.seq} would break a later change: ${first.why}`
		: `the retraction at seq ${envelope.seq} would change a later change at seq ${first.batch.seqs[0] ?? 0}: ${first.why}`;
};

const retract = (state: TableState, envelope: Envelope): Restored => {
	const { seqs, undone } = decodePayload(Retracted, envelope);
	const { index, batch } = retractionTarget(state, envelope, seqs);

	if (undone.some(hasTerminalControls)) {
		throw new Error(`unsafe text in the retraction at seq ${envelope.seq}`);
	}

	const taken = without(state, index, batch);

	if ("changed" in taken) {
		throw new Error(brokenBy(envelope, taken.changed[0]));
	}

	const { restored, skipped } = taken;

	const entry: RedoEntry = {
		seqs,
		actor: batch.actor,
		by: envelope.actor,
		events: batch.events,
		after: skipped,
		rolled: batch.rolled,
		undone: batch.undone,
	};

	const latest = index === state.undo.length - 1;

	const left: RedoEntry = latest
		? { ...entry, left: snapshot(restored) }
		: entry;

	return {
		note: {
			kind: UNDO_KIND,
			text:
				undone.length === 0
					? "undid the last change."
					: `undid: ${joinLines(undone)}`,
		},
		restored: { ...restored, redo: [...state.redo, left].slice(-UNDO_DEPTH) },
	};
};

const sameSeqs = (
	a: ReadonlyArray<number>,
	b: ReadonlyArray<number>
): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

const putBack = (state: TableState, envelope: Envelope): Restored => {
	const { seqs } = decodePayload(Redone, envelope);
	const top = state.redo.at(-1);

	if (top === undefined || !sameSeqs(top.seqs, seqs)) {
		throw new Error(`the redo at seq ${envelope.seq} isn't of the latest undo`);
	}

	const { slices, texts, skipped } = refold(snapshot(state), [
		...top.events,
		...top.after,
	]);

	const why = difference(top.undone, texts);

	if (why !== undefined) {
		throw new Error(
			`the redo at seq ${envelope.seq} would come out differently: ${why}`
		);
	}

	const batch: UndoBatch = {
		seqs: [envelope.seq],
		actor: top.actor,
		timestamp: envelope.timestamp,
		undone: texts,
		before: snapshot(state),
		events: top.events,
		after: top.after.filter((e) => !skipped.includes(e)),
		rolled: top.rolled,
	};

	return {
		note: {
			kind: REDO_KIND,
			text:
				texts.length === 0
					? "redid the last change."
					: `redid: ${joinLines(texts)}`,
		},
		restored: {
			...state,
			...slices,
			undo: [...state.undo, batch].slice(-UNDO_DEPTH),
			redo: state.redo.slice(0, -1),
		},
	};
};

interface Folded {
	readonly next: TableState;
	readonly feed: FeedNote | undefined;
}

const foldSlice = (state: TableState, envelope: Envelope): Folded => {
	const applied = applySlice(snapshot(state), envelope);
	const top = state.undo.at(-1);

	if (RETRACTABLE.has(envelope.type)) {
		return {
			next: {
				...state,
				...applied.slices,
				undo: pushed(state, envelope, applied.feed),
				redo: [],
			},
			feed: applied.feed,
		};
	}

	const undo =
		applied.changed && top !== undefined
			? [
					...state.undo.slice(0, -1),
					{ ...top, after: [...top.after, envelope] },
				]
			: state.undo;

	return {
		next: { ...state, ...applied.slices, undo },
		feed: applied.feed,
	};
};

const foldOne = (state: TableState, envelope: Envelope): Folded => {
	if (envelope.type === RETRACTED || envelope.type === REDONE) {
		const { restored, note } =
			envelope.type === RETRACTED
				? retract(state, envelope)
				: putBack(state, envelope);

		return { next: restored, feed: note };
	}

	if (CORE_EVENTS.has(envelope.type)) {
		const applied = core.apply(state.core, envelope);

		return { next: { ...state, core: applied.slice }, feed: applied.feed };
	}

	if (STAGE_EVENTS.has(envelope.type)) {
		const applied = applyStage(state.stage, envelope, inCombatAny(state));

		return { next: { ...state, stage: applied.slice }, feed: applied.feed };
	}

	return foldSlice(state, envelope);
};

const knows = (type: string): boolean =>
	type === RETRACTED ||
	type === REDONE ||
	CORE_EVENTS.has(type) ||
	DS_EVENTS.has(type) ||
	SW_EVENTS.has(type) ||
	PF_EVENTS.has(type) ||
	FF_EVENTS.has(type) ||
	STAGE_EVENTS.has(type);

const entryOf = (envelope: Envelope, feed: FeedNote): FeedEntry => {
	const entry: FeedEntry = {
		seq: envelope.seq,
		actor: envelope.actor,
		kind: feed.kind,
		text: feed.text,
	};

	return feed.speaker === undefined
		? entry
		: { ...entry, speaker: feed.speaker };
};

const apply = (state: TableState, envelope: Envelope): TableState => {
	if (!knows(envelope.type)) {
		throw new Error(`unknown event type "${envelope.type}"`);
	}

	if (!Number.isInteger(envelope.seq) || envelope.seq <= state.seq) {
		throw new Error(`seq ${envelope.seq} does not follow seq ${state.seq}`);
	}

	const { next, feed } = foldOne(state, envelope);

	const actors = state.actors.includes(envelope.actor)
		? state.actors
		: [...state.actors, envelope.actor];

	const entries =
		feed === undefined
			? state.feed
			: [...state.feed, entryOf(envelope, feed)].slice(-FEED_LIMIT);

	return {
		...next,
		stage: afterCombat(next.stage, inCombatAny(next)),
		seq: envelope.seq,
		actors,
		feed: entries,
	};
};

const skip = (state: TableState, envelope: Envelope): TableState => {
	const top = state.undo.at(-1);

	const undo = continues(top, state, envelope)
		? [
				...state.undo.slice(0, -1),
				{ ...top, loose: [...orEmpty(top.loose), envelope.seq] },
			]
		: [
				...state.undo,
				{
					...opened(state, envelope),
					seqs: [],
					events: [],
					loose: [envelope.seq],
				},
			].slice(-UNDO_DEPTH);

	return { ...state, undo, seq: Math.max(state.seq, envelope.seq) };
};

export const KNOCK_FIRST = "Knock first: the GM hasn't let you in.";

const decide = (
	state: TableState,
	actor: string,
	command: Command,
	dice: Dice,
	now: number
): Decision => {
	if (!isMember(state, actor)) {
		return refuse(KNOCK_FIRST);
	}

	if (command.type === "undo") {
		return decideUndo(state, actor, command, now);
	}

	if (command.type === "redo") {
		return decideRedo(state, actor);
	}

	const spec = BY_TYPE.get(command.type);

	if (spec === undefined) {
		return refuse(`There is no "${command.type}" command.`);
	}

	if (spec.gmOnly && actor !== GM) {
		return refuse(`Only the GM can use /${spec.name}.`);
	}

	const shared: Shared = {
		actors: state.actors,
		label: (who) => label(state, who),
		now,
	};

	if (isCoreCommand(command)) {
		return core.decide(state.core, shared, actor, command, dice);
	}

	if (isDsCommand(command)) {
		return drawSteel.decide(state.ds, shared, actor, command, dice);
	}

	if (isSetCommand(command)) {
		return setWorld.decide(state.sw, shared, actor, command, dice);
	}

	if (isPfCommand(command)) {
		return pf2e.decide(state.pf, shared, actor, command, dice);
	}

	if (isFfCommand(command)) {
		return freeform.decide(state.ff, shared, actor, command, dice);
	}

	if (isStageCommand(command)) {
		return decideStage(state.stage, inCombatAny(state), command);
	}

	return refuse(`There is no "${spec.type}" command.`);
};

export const initial: TableState = {
	seq: 0,
	actors: [],
	feed: [],
	undo: [],
	redo: [],
	core: core.initial,
	ds: drawSteel.initial,
	sw: setWorld.initial,
	pf: pf2e.initial,
	ff: freeform.initial,
	stage: initialStage,
};

export const rules: Rules<TableState, Command> = {
	initial,
	knows,
	decide,
	apply,
	skip,
};
