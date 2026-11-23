import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import {
	actionsOf,
	bandOf,
	completeLine,
	feedLines,
	GM,
	mapOf,
	nameOf,
	prepOf,
	tableLabel,
} from "@supervillain/domain";
import type { PrepCatalog } from "@supervillain/domain";
import type { Line } from "@supervillain/platform-jsonl";
import { Array as Arr, Cause, Effect, FiberSet, Option, Stream } from "effect";
import type { Scope, Types } from "effect";
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

import { CampaignContent } from "../content/index.ts";
import { App } from "../table/App.tsx";
import { kept } from "../table/keep.ts";
import type { PrepSource, Present, TableView } from "../table/view.ts";
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
		yield* presence.enter(actor);
		const state = yield* follow({ get: room.state, changes: room.changes });

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
				await run(loadCatalog).catch(() => Option.none<string>())
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
				const names = createMemo(() => state().core.names);

				const mapId = createMemo(() => {
					if (ruleset === "set-world") {
						return sw().map?.id;
					}

					if (ruleset === "pf2e") {
						return pf().map?.id;
					}

					return ds().map?.id;
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
				}

				return {
					combat: projected(
						() =>
							bandOf(
								{ ds: ds(), sw: sw(), pf: pf(), core: { names: names() } },
								actor,
								ruleset
							),
						undefined
					),
					map: projected(
						() =>
							mapOf(
								{ ds: ds(), sw: sw(), pf: pf(), core: { names: names() } },
								actor,
								ruleset
							),
						undefined
					),
					prep: projected(() => {
						const files = catalog();

						return files === undefined
							? undefined
							: prepOf(
									{ ds: ds(), sw: sw(), pf: pf(), core: { names: names() } },
									files,
									ruleset
								);
					}, undefined),
				};
			})(),
		}));

		yield* Effect.addFinalizer(() => Effect.sync(derived.dispose));

		const prep: PrepSource = { view: derived.prep, reload };

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
			complete: (line) => completeLine(state(), actor, line, ruleset),
			actions: (id) => actionsOf(state(), actor, ruleset, id),
			debug: () =>
				actor === GM
					? debugText(state(), recent())
					: "Only the GM can see the table's state.",
			leave: options.leave,
		};

		if (actor === GM) {
			view.prep = prep;
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
