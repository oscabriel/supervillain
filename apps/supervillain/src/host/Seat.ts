import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import {
	ActorId,
	actionsOf,
	bandOf,
	checkName,
	completeLine,
	feedLines,
	fightLinesOf,
	GM,
	isMember,
	isRefused,
	mapOf,
	nameOf,
	namesInPlay,
	partyOf,
	prepOf,
	prepStage,
	resyncLinesOf,
	shortFingerprint,
	stageOf,
	tableLabel,
} from "@supervillain/domain";
import type {
	PrepCatalog,
	PrepItem,
	PrepSection,
	Prose,
	TableState,
} from "@supervillain/domain";
import type { Line } from "@supervillain/platform-jsonl";
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Option,
	Ref,
	Result,
	Schema,
	Scope,
	Stream,
} from "effect";
import type { Types } from "effect";
import {
	catchError,
	createComponent,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	on,
} from "solid-js";
import type { Accessor } from "solid-js";

import {
	CampaignContent,
	gmNotesFor,
	isGmHeading,
	keyedDocs,
	proseOf,
} from "../content/index.ts";
import type { ContentIndex } from "../content/index.ts";
import { App } from "../table/App.tsx";
import { Doorway } from "../table/Doorway.tsx";
import { kept } from "../table/keep.ts";
import type {
	KnockShown,
	KnockStatus,
	KnockView,
	PrepSource,
	Present,
	TableView,
} from "../table/view.ts";
import { ContentWatch } from "./ContentWatch.ts";
import { Knocks, knockCompletions } from "./Knocks.ts";
import type { Knock } from "./Knocks.ts";
import { debugText, runLine } from "./line.ts";
import type { Reply } from "./line.ts";
import { Presence } from "./Presence.ts";
import type { TableServices } from "./services.ts";
import { TableRoom } from "./TableRoom.ts";
import type { View } from "./View.ts";

const BATCH = "16 millis";

const RECENT = 8;

const HELP_LINE = /^\s*\/help\s*$/iu;

export interface SeatOptions {
	readonly actor: string;
	readonly rateKey?: string;
	readonly room: string;
	readonly leave: () => void;
	readonly helpFooter?: string;
	readonly joinHint?: string;
	readonly joinNote?: View<string>;
	readonly alert?: View<string | undefined>;
}

const follow = <A>(
	view: View<A>
): Effect.Effect<Accessor<A>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const [get, set] = createSignal<A>(yield* view.get, { equals: false });
		yield* view.changes.pipe(
			Stream.groupedWithin(1024, BATCH),
			Stream.runForEach((batch) =>
				Effect.sync(() => {
					const last = Arr.last(batch);

					if (Option.isSome(last)) {
						set(() => last.value);
					}
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logError("a seat couldn't draw a change", cause)
					)
				)
			),
			Effect.forkScoped
		);

		return get;
	});

const notesProse = (text: string): Prose => {
	const prose = proseOf(text);
	const [first, ...rest] = prose;

	return first?.kind === "heading" && isGmHeading(first.text) ? rest : prose;
};

const replyText = (reply: Reply): string | undefined =>
	reply.kind === "message" || reply.kind === "refusal" ? reply.text : undefined;

export const openSeat = (
	options: SeatOptions
): Effect.Effect<TableView, never, Scope.Scope | TableServices> =>
	Effect.gen(function* () {
		const { actor } = options;
		const room = yield* TableRoom;
		const presence = yield* Presence;
		const content = yield* CampaignContent;
		const { ruleset } = content;
		const knocks = yield* Knocks;
		const watch = yield* ContentWatch;
		yield* presence.enter(actor, options.leave);

		if (actor !== GM) {
			yield* room.changes.pipe(
				Stream.filter((now) => !isMember(now, actor)),
				Stream.take(1),
				Stream.runForEach(() =>
					Effect.andThen(
						Effect.logInfo(`seat ${actor}: no longer a member; closing`),
						Effect.sync(options.leave)
					)
				),
				Effect.forkScoped
			);
		}

		const state = yield* follow({ get: room.state, changes: room.changes });

		const pending = yield* follow<ReadonlyArray<Knock>>(
			actor === GM
				? knocks.pending
				: { get: Effect.succeed([]), changes: Stream.empty }
		);

		const latest = room.recent(RECENT).pipe(
			Effect.tapError((failure) =>
				Effect.logError(`seat ${actor}: couldn't read recent log`, failure)
			),
			Effect.orElseSucceed((): ReadonlyArray<Line> => [])
		);

		const recent = yield* follow<ReadonlyArray<Line>>(
			actor === GM
				? {
						get: latest,
						changes: room.changes.pipe(Stream.mapEffect(() => latest)),
					}
				: { get: Effect.succeed([]), changes: Stream.empty }
		);

		const here = yield* follow(presence.here);

		const index = yield* follow<ContentIndex | undefined>(
			actor === GM
				? watch.index
				: { get: Effect.undefined, changes: Stream.empty }
		);

		const problems = yield* follow<ReadonlyArray<string>>(
			actor === GM
				? watch.problems
				: { get: Effect.succeed([]), changes: Stream.empty }
		);

		const stale = yield* follow<ReadonlyArray<string>>(
			actor === GM
				? watch.stale
				: { get: Effect.succeed([]), changes: Stream.empty }
		);

		const held = yield* follow<ReadonlyArray<string>>(
			actor === GM
				? watch.held
				: { get: Effect.succeed([]), changes: Stream.empty }
		);

		const joinNote =
			options.joinNote === undefined
				? undefined
				: yield* follow(options.joinNote);

		const alert =
			options.alert === undefined ? undefined : yield* follow(options.alert);

		const run = yield* FiberSet.makeRuntimePromise<TableServices>();
		const fork = yield* FiberSet.makeRuntime<TableServices>();

		const projected = <A>(project: () => A, initial: A) =>
			createMemo<A>((was) => {
				try {
					return kept(was, project());
				} catch (error) {
					fork(
						Effect.logError(
							`seat ${actor}: couldn't project the table`,
							Cause.die(error)
						)
					);

					return was;
				}
			}, initial);

		const [catalog, setCatalog] = createSignal<PrepCatalog>();

		const loadCatalog = content.catalog.pipe(
			Effect.match({
				onFailure: (failure) => Option.some(failure.message),
				onSuccess: (files) => {
					setCatalog(files);

					return Option.none<string>();
				},
			})
		);

		const reload = async (): Promise<string | undefined> =>
			Option.getOrUndefined(
				await run(Effect.andThen(watch.recheck, loadCatalog)).catch(() =>
					Option.none<string>()
				)
			);

		const derived = createRoot((dispose) => ({
			dispose,
			feed: projected(
				() => feedLines(state(), tableLabel(state(), ruleset)),
				[]
			),
			present: projected((): ReadonlyArray<Present> => {
				const label = tableLabel(state(), ruleset);

				return here().map((a) => ({ actor: a, label: label(a), gm: a === GM }));
			}, []),
			myName: projected(() => nameOf(state(), actor), undefined),
			...(() => {
				const ds = createMemo(() => state().ds);
				const sw = createMemo(() => state().sw);
				const pf = createMemo(() => state().pf);
				const ff = createMemo(() => state().ff);
				const stage = createMemo(() => state().stage);
				const names = createMemo(() => state().core.names);

				const slices = createMemo(() => ({
					ds: ds(),
					sw: sw(),
					pf: pf(),
					ff: ff(),
					stage: stage(),
					core: { names: names() },
				}));

				const mapId = createMemo(() => {
					const now = slices();

					if (ruleset === "set-world") {
						return now.sw.map?.id;
					}

					if (ruleset === "pf2e") {
						return now.pf.map?.id;
					}

					if (ruleset === "freeform") {
						return now.ff.map?.id;
					}

					return now.ds.map?.id;
				});

				if (actor === GM) {
					createEffect(
						on(
							mapId,
							(id) => {
								const files = catalog();

								if (
									id !== undefined &&
									files !== undefined &&
									!files.maps.some((m) => m.id === id)
								) {
									fork(loadCatalog);
								}
							},
							{ defer: true }
						)
					);

					createEffect(
						on(
							index,
							() => {
								if (catalog() !== undefined) {
									fork(loadCatalog);
								}
							},
							{ defer: true }
						)
					);
				}

				const notes = createMemo((): ReadonlyMap<string, Prose> => {
					const now = index();

					if (now === undefined) {
						return new Map();
					}

					return new Map(
						keyedDocs(now).flatMap((k) => {
							const text = gmNotesFor(now, k.key);

							return text === undefined
								? []
								: [[k.key, notesProse(text)] as const];
						})
					);
				});

				return {
					notes,
					combat: projected(() => bandOf(slices(), actor, ruleset), undefined),
					map: projected(() => mapOf(slices(), actor, ruleset), undefined),
					stage: projected(() => stageOf(slices(), actor, ruleset), undefined),
					party: projected(() => partyOf(slices(), actor, ruleset), []),
					prep: projected(() => {
						const files = catalog();

						return files === undefined
							? undefined
							: prepOf(slices(), files, ruleset);
					}, undefined),
					prepStage: projected((): ReadonlyArray<PrepSection> => {
						const files = catalog();

						return files === undefined
							? []
							: prepStage(slices().stage, files, (encounter) =>
									fightLinesOf(encounter, ruleset)
								);
					}, []),
					sync: projected((): PrepItem | undefined => {
						const { cards } = slices().stage;
						const shown = held().filter((key) => cards[key] !== undefined);

						const lines = [
							...resyncLinesOf(slices(), stale(), ruleset),
							...shown.map((key) => `/sync ${key}`),
						];

						const [first] = lines;

						if (first === undefined) {
							return undefined;
						}

						const members = partyOf(slices(), actor, ruleset);

						const named = [
							...stale().map(
								(id) => members.find((m) => m.id === id)?.name ?? id
							),
							...shown.map((key) => cards[key]?.card.title ?? key),
						];

						return {
							kind: "send",
							label: `Sync ${named.join(", ")}`,
							line: first,
							lines,
						};
					}, undefined),
				};
			})(),
		}));

		yield* Effect.addFinalizer(() => Effect.sync(derived.dispose));

		const prep: PrepSource = {
			view: derived.prep,
			reload,
			stage: derived.prepStage,
			sync: derived.sync,
		};

		const footer =
			options.helpFooter === undefined ? "" : `\n\n${options.helpFooter}`;

		const view: Types.Mutable<TableView> = {
			me: actor,
			room: options.room,
			feed: derived.feed,
			present: derived.present,
			myName: derived.myName,
			combat: derived.combat,
			map: derived.map,
			stage: derived.stage,
			party: derived.party,
			submit: async (line) =>
				await run(
					runLine(actor, line, "seat", options.rateKey ?? actor).pipe(
						Effect.map((reply) => {
							const text = replyText(reply);

							return reply.kind === "message" && HELP_LINE.test(line)
								? `${text}${footer}`
								: text;
						})
					)
				),
			complete: (line) =>
				(actor === GM ? knockCompletions(line, pending()) : undefined) ??
				completeLine(state(), actor, line, ruleset),
			actions: (id) => actionsOf(state(), actor, ruleset, id),
			debug: () =>
				actor === GM
					? debugText(state(), recent())
					: "Only the GM can see the table's state.",
			leave: options.leave,
		};

		if (actor === GM) {
			view.prep = prep;
			view.knocks = createMemo(() => pending().map(shownKnock));
			view.gmNotes = (key) => derived.notes().get(key);
			view.contentProblems = problems;
		}

		if (options.joinHint !== undefined) {
			view.joinHint = options.joinHint;
		}

		if (joinNote !== undefined) {
			view.joinNote = joinNote;
		}

		if (alert !== undefined) {
			view.alert = alert;
		}

		return view;
	});

const shownKnock = (knock: Knock): KnockShown => ({
	actor: knock.actor,
	name: knock.name,
	short: shortFingerprint(knock.fingerprint),
});

const isActorId = Schema.is(ActorId);

const TURNED_AWAY_MS = 4000;

const DENIED_TEXT =
	"The GM didn't let you in this time. You can knock again in 10 minutes.";

const EXPIRED_TEXT =
	"Nobody answered the door for 10 minutes; knock again when the GM is about.";

const SPENT_INVITE =
	"That invite has run out: knock instead, and the GM decides.";

export const NAMING_TIMEOUT_MS = 2 * 60_000;

export const NAMING_TIMEOUT_TEXT =
	"Nobody knocked for 2 minutes, so the door closed. Reconnect when you're ready.";

const removed = (state: TableState, actor: string) =>
	state.core.members[actor] === "out";

export interface KnockSeatOptions extends SeatOptions {
	readonly fingerprint: string;
	readonly bucket: string;
	readonly invite?: string;
}

export const knockSeat = (
	renderer: CliRenderer,
	options: KnockSeatOptions
): Effect.Effect<void, never, Scope.Scope | TableServices> =>
	Effect.gen(function* () {
		const { actor, fingerprint, bucket } = options;
		const room = yield* TableRoom;
		const knocks = yield* Knocks;
		const presence = yield* Presence;
		const scope = yield* Scope.Scope;

		const invited =
			options.invite !== undefined &&
			!removed(yield* room.state, actor) &&
			(yield* knocks.holds(options.invite));

		const [status, setStatus] = createSignal<KnockStatus>({
			kind: "naming",
			invited,
		});

		const [table, setTable] = createSignal<TableView>();
		const admitted = yield* Deferred.make<"in">();
		const turned = yield* Deferred.make<string>();
		const waiter = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

		const run = yield* FiberSet.makeRuntimePromise<TableServices>();

		yield* room.changes.pipe(
			Stream.filter((state) => isMember(state, actor)),
			Stream.take(1),
			Stream.runDrain,
			Effect.andThen(Deferred.succeed(admitted, "in")),
			Effect.forkScoped
		);

		const knockAs = Effect.fn("Seat.knockAs")(function* (name: string) {
			const state = yield* room.state;
			const seated = yield* presence.here.get;

			const { [actor]: _held, ...others } = state.core.names;
			const fresh = { ...state, core: { ...state.core, names: others } };

			const checked = checkName(fresh, actor, name, {
				seated,
				cast: namesInPlay(state),
			});

			if (isRefused(checked)) {
				return Option.some(checked.refusal);
			}

			if (!isActorId(actor)) {
				return Option.some(`${actor} can't sit at this table.`);
			}

			const current = status();
			const token = options.invite;

			if (
				current.kind === "naming" &&
				current.invited &&
				token !== undefined &&
				!removed(state, actor)
			) {
				const spent = yield* knocks.redeem(token);

				if (!spent) {
					setStatus({ kind: "naming", invited: false, said: SPENT_INVITE });

					return Option.none<string>();
				}

				const sat = yield* Effect.result(
					room
						.submit(GM, {
							type: "admit",
							who: actor,
							member: actor,
							name: checked,
							by: "invite",
						})
						.pipe(
							Effect.onExit((exit) =>
								knocks.settle(token, Exit.isSuccess(exit))
							)
						)
				);

				return Result.isFailure(sat)
					? Option.some(sat.failure.message)
					: Option.none<string>();
			}

			const knocked = yield* Effect.result(
				knocks
					.knock({ actor, name: checked, fingerprint, bucket })
					.pipe(Scope.provide(scope))
			);

			if (Result.isFailure(knocked)) {
				return Option.some(knocked.failure.message);
			}

			setStatus({ kind: "waiting", name: checked });

			const fiber = yield* knocked.success.ended.pipe(
				Effect.flatMap((end) =>
					Deferred.succeed(
						turned,
						end === "denied" ? DENIED_TEXT : EXPIRED_TEXT
					)
				),
				Effect.asVoid,
				Effect.forkIn(scope)
			);

			yield* Ref.set(waiter, Option.some(fiber));

			return Option.none<string>();
		});

		const view: KnockView = {
			room: options.room,
			me: shortFingerprint(fingerprint),
			status,
			knock: async (name) => Option.getOrUndefined(await run(knockAs(name))),
			leave: options.leave,
		};

		yield* mountDoorway(renderer, view, table);

		yield* Effect.sleep(NAMING_TIMEOUT_MS).pipe(
			Effect.andThen(
				Effect.suspend(() =>
					status().kind === "naming"
						? Deferred.succeed(turned, NAMING_TIMEOUT_TEXT)
						: Effect.void
				)
			),
			Effect.forkScoped
		);

		const outcome = yield* Effect.raceFirst(
			Deferred.await(admitted),
			Deferred.await(turned)
		);

		if (outcome === "in") {
			const waiting = yield* Ref.get(waiter);

			if (Option.isSome(waiting)) {
				yield* Fiber.interrupt(waiting.value);
			}

			yield* Effect.logInfo(`seat ${actor}: let in at the door`);
			setTable(yield* openSeat(options));

			return yield* Effect.never;
		}

		setStatus({ kind: "turned", text: outcome });
		yield* Effect.logInfo(`seat ${actor}: turned away at the door`);
		yield* Effect.sleep(TURNED_AWAY_MS);
		options.leave();

		return yield* Effect.never;
	});

const mountDoorway = (
	renderer: CliRenderer,
	knock: KnockView,
	table: Accessor<TableView | undefined>
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const fork = yield* FiberSet.makeRuntime();

		const report = (cause: unknown) => {
			fork(
				Effect.logError(
					`seat ${knock.me}: couldn't draw the door`,
					Cause.die(cause)
				)
			);
		};

		yield* Effect.promise(async () => {
			await render(
				() =>
					catchError(() => createComponent(Doorway, { knock, table }), report),
				renderer
			);
		});
	});

export const mountTable = (
	renderer: CliRenderer,
	view: TableView
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const fork = yield* FiberSet.makeRuntime();

		const report = (cause: unknown) => {
			fork(
				Effect.logError(
					`seat ${view.me}: couldn't draw the table`,
					Cause.die(cause)
				)
			);
		};

		yield* Effect.promise(async () => {
			await render(
				() => catchError(() => createComponent(App, { view }), report),
				renderer
			);
		});
	});
