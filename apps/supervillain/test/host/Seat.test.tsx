import { describe, expect } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
	Cause,
	Effect,
	Exit,
	Layer,
	Logger,
	Schema,
	Scope,
	SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";

import { CampaignContent } from "../../src/content/index.ts";
import { runLine } from "../../src/host/line.ts";
import {
	knockSeat,
	mountTable,
	NAMING_TIMEOUT_MS,
	NAMING_TIMEOUT_TEXT,
	openSeat,
} from "../../src/host/Seat.ts";
import { tableServices } from "../../src/host/services.ts";
import type { TableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { TableView } from "../../src/table/view.ts";
import { campaignOf, FULL } from "../content/files.ts";
import { combatant, fight, vex } from "../table/combat.ts";
import { fakeView } from "../table/fakeView.ts";
import {
	DOOR_OPEN_LINE,
	openSampleCampaign,
	sampleCampaign,
} from "./campaign.ts";
import { effect, must, waitFor } from "./effect.ts";
import type { Platform } from "./effect.ts";

const alice = "key:SHA256:aliceAAAAkeyfingerprint";

const bob = "key:SHA256:bobBBBBBkeyfingerprint";

const using = <ROut, E1, RIn, A, E2, R2>(
	layer: Layer.Layer<ROut, E1, RIn>,
	body: Effect.Effect<A, E2, R2>
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provideContext(body, context)
		)
	);

const atTable = <A, E>(body: Effect.Effect<A, E, TableServices | Platform>) =>
	Effect.gen(function* () {
		const dir = yield* sampleCampaign;

		return yield* using(tableServices(dir), body);
	});

const atOpenTable = <A, E>(
	body: Effect.Effect<A, E, TableServices | Platform>
) =>
	Effect.gen(function* () {
		const dir = yield* openSampleCampaign;

		return yield* using(tableServices(dir), body);
	});

const capturing = (logs: Array<string>) =>
	Logger.make(({ message, cause }) => {
		logs.push(`${String(message)} ${Cause.pretty(cause)}`);
	});

const reload = (view: TableView) =>
	Effect.promise(
		async () => await must(view.prep, "the GM has a prep panel").reload()
	);

const prepNow = (view: TableView) =>
	must(view.prep?.view(), "the prep lists are loaded");

interface Seated {
	readonly t: TestRendererSetup;
	readonly view: Effect.Success<ReturnType<typeof openSeat>>;
	readonly left: () => number;
	readonly close: Effect.Effect<void>;
}

const seat = (actor: string) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		let left = 0;

		const t = yield* Effect.acquireRelease(
			Effect.promise(
				async () =>
					await createTestRenderer({
						width: 100,
						height: 30,
						exitOnCtrlC: false,
					})
			),
			(setup) =>
				Effect.sync(() => {
					setup.renderer.destroy();
				})
		).pipe(Scope.provide(scope));

		const view = yield* openSeat({
			actor,
			room: "den",
			leave: () => {
				left += 1;
			},
		}).pipe(Scope.provide(scope));

		yield* mountTable(t.renderer, view);
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

		return {
			t,
			view,
			left: () => left,
			close: Scope.close(scope, Exit.void),
		} satisfies Seated;
	});

const overState = (actor: string) =>
	Effect.gen(function* () {
		const room = yield* TableRoom;
		const state = yield* SubscriptionRef.make(yield* room.state);
		const logs: Array<string> = [];

		const view = yield* openSeat({
			actor,
			room: "den",
			leave: () => {},
		}).pipe(
			Effect.provideService(TableRoom, {
				...room,
				state: SubscriptionRef.get(state),
				changes: SubscriptionRef.changes(state),
			}),
			Effect.provideService(Logger.CurrentLoggers, new Set([capturing(logs)]))
		);

		return { room, state, logs, view };
	});

const frameAfter = async (
	t: TestRendererSetup,
	what: string,
	predicate: (frame: string) => boolean,
	deadline: number
): Promise<string> => {
	await t.renderOnce();
	const frame = t.captureCharFrame();

	if (predicate(frame)) {
		return frame;
	}

	if (performance.now() > deadline) {
		throw new Error(`timed out waiting for ${what}:\n${frame}`);
	}

	await Bun.sleep(10);

	return await frameAfter(t, what, predicate, deadline);
};

const frameWhere = (
	s: Pick<Seated, "t">,
	what: string,
	predicate: (frame: string) => boolean
) =>
	Effect.promise(
		async () => await frameAfter(s.t, what, predicate, performance.now() + 3000)
	);

const type = (s: Seated, text: string) =>
	Effect.promise(async () => {
		await s.t.mockInput.typeText(text);
		s.t.mockInput.pressEnter();
	});

describe("a seat over a real room", () => {
	effect(
		"follows a view to undefined and back: the GM's relay alert clears once the link is up",
		() =>
			atTable(
				Effect.gen(function* () {
					const alert = yield* SubscriptionRef.make<string | undefined>(
						"relay: connecting…"
					);

					const view = yield* openSeat({
						actor: "gm",
						room: "den",
						leave: () => {},
						alert: {
							get: SubscriptionRef.get(alert),
							changes: SubscriptionRef.changes(alert),
						},
					});

					const settled = (want: string | undefined) =>
						waitFor(
							`the alert to read ${want ?? "nothing"}`,
							() => view.alert?.() === want,
							2000
						);

					yield* settled("relay: connecting…");
					yield* SubscriptionRef.set(alert, undefined);
					yield* settled(undefined);
					yield* SubscriptionRef.set(alert, "relay: down, redialing");
					yield* settled("relay: down, redialing");
				})
			)
	);

	effect("asks a new player's name, then chat reaches every seat's feed", () =>
		atOpenTable(
			Effect.gen(function* () {
				const a = yield* seat(alice);
				const b = yield* seat(bob);
				yield* frameWhere(a, "the name prompt", (f) =>
					f.includes("what should the table call you?")
				);
				yield* type(a, "Alice");
				yield* frameWhere(
					a,
					"chat mode",
					(f) => !f.includes("what should the table call you?")
				);
				yield* type(a, "hello all");
				yield* frameWhere(a, "the line in Alice's feed", (f) =>
					f.includes("Alice: hello all")
				);
				yield* frameWhere(b, "the line in Bob's feed", (f) =>
					f.includes("Alice: hello all")
				);
				expect(b.view.myName()).toBeUndefined();
				expect(a.view.myName()).toBe("Alice");
			})
		)
	);

	effect("labels every line by the speaker's current name", () =>
		atOpenTable(
			Effect.gen(function* () {
				const a = yield* seat(alice);
				const b = yield* seat(bob);
				yield* type(a, "/say hi before my name");
				yield* frameWhere(b, "the default label", (f) =>
					f.includes("aliceAAA: hi before my name")
				);
				yield* type(a, "Alice");
				yield* frameWhere(b, "the relabelled line", (f) =>
					f.includes("Alice: hi before my name")
				);
				expect(b.view.feed().map((l) => l.who)).toEqual([
					"GM",
					"Alice",
					"Alice",
				]);
			})
		)
	);

	effect("shows who is here until each seat's scope closes", () =>
		atTable(
			Effect.gen(function* () {
				const a = yield* seat(alice);
				const b = yield* seat(bob);
				yield* frameWhere(a, "Bob's seat", (f) => f.includes("bobBBBBB"));
				expect(a.view.present()).toEqual([
					{ actor: alice, label: "aliceAAA", gm: false },
					{ actor: bob, label: "bobBBBBB", gm: false },
				]);
				yield* b.close;
				yield* frameWhere(a, "Bob gone", (f) => !f.includes("bobBBBBB"));
				expect(a.view.present().map((p) => p.actor)).toEqual([alice]);
			})
		)
	);

	effect(
		"answers /help to this seat only, and Ctrl-C leaves without writing",
		() =>
			atOpenTable(
				Effect.gen(function* () {
					const g = yield* seat("gm");
					const b = yield* seat(bob);
					yield* type(g, "/help");
					yield* frameWhere(g, "the help pane", (f) =>
						f.includes("/narrate <text>")
					);
					yield* type(b, "Bob");
					yield* type(g, "/narrate after the help");

					const bobs = yield* frameWhere(b, "the GM's next line", (f) =>
						f.includes("after the help")
					);

					expect(bobs).not.toContain("/narrate <text>");
					b.t.mockInput.pressCtrlC();
					expect(b.left()).toBe(1);
					expect((yield* Effect.flatMap(TableRoom, (r) => r.state)).seq).toBe(
						3
					);
				})
			)
	);

	effect(
		"keeps each feed row's object across unrelated appends, and relabels on a rename",
		() =>
			atOpenTable(
				Effect.gen(function* () {
					const a = yield* seat(alice);
					yield* type(a, "Alice");
					yield* frameWhere(a, "chat mode", (f) =>
						f.includes("say something, or /help")
					);
					yield* type(a, "first");
					yield* frameWhere(a, "the first line", (f) =>
						f.includes("Alice: first")
					);
					const before = a.view.feed();
					yield* type(a, "second");
					yield* frameWhere(a, "the second line", (f) =>
						f.includes("Alice: second")
					);
					const after = a.view.feed();
					expect(after).toHaveLength(4);
					expect(after[0]).toBe(before[0]);
					expect(after[1]).toBe(before[1]);
					expect(after[2]).toBe(before[2]);
					yield* type(a, "/name Vex");
					yield* frameWhere(a, "the rename", (f) => f.includes("Vex: first"));
					expect(a.view.feed()[2]).not.toBe(before[2]);
					expect(a.view.feed()[2]).toMatchObject({ who: "Vex", text: "first" });
				})
			)
	);

	effect("refusals show on the seat that sent them", () =>
		atOpenTable(
			Effect.gen(function* () {
				const b = yield* seat(bob);
				yield* type(b, "Bob");
				yield* type(b, "/narrate The sky falls.");
				yield* frameWhere(b, "the refusal", (f) =>
					f.includes("Only the GM can use /narrate.")
				);
				expect(b.view.complete("/ro")).toEqual(["/roll "]);
			})
		)
	);

	effect(
		"draws the band from the room: the party, each seat's own hero, then the fight",
		() =>
			atOpenTable(
				Effect.gen(function* () {
					const g = yield* seat("gm");
					const a = yield* seat(alice);
					expect(g.view.combat?.()).toBeUndefined();
					yield* type(a, "Alice");
					yield* type(g, "/hero brann");
					yield* type(g, "/hero kesh");
					yield* frameWhere(g, "the party", (f) =>
						f.includes("party · hero tokens 0")
					);
					yield* type(a, "/play brann");
					yield* frameWhere(g, "Brann's player", (f) =>
						f.includes("Brann (Alice)")
					);
					expect(
						g.view.combat?.()?.combatants.map((c) => [c.name, c.mine])
					).toEqual([
						["Brann (Alice)", false],
						["Kesh", false],
					]);
					expect(
						a.view.combat?.()?.combatants.map((c) => [c.name, c.mine])
					).toEqual([
						["Brann", true],
						["Kesh", false],
					]);
					expect(g.view.present().map((p) => p.label)).toEqual([
						"GM",
						"Alice (Brann)",
					]);

					yield* type(g, "/add bandit-chief");
					yield* frameWhere(g, "the chief", (f) =>
						f.includes("Bandit Chief joins the fight")
					);
					yield* type(g, "/start");
					yield* frameWhere(a, "the fight", (f) => f.includes("round 1"));
					const band = a.view.combat?.();
					expect(band).toMatchObject({ active: true, round: 1 });
					expect(
						band?.combatants.map((c) => [c.id, c.side, c.stamina, c.max])
					).toEqual([
						["brann", "heroes", 24, 24],
						["kesh", "heroes", 24, 24],
						["bandit-chief", "director", 80, 80],
					]);
				})
			)
	);

	effect(
		"a chat line leaves the band and the map as they were, and a damage the map, so neither is drawn again",
		() =>
			atTable(
				Effect.gen(function* () {
					const g = yield* seat("gm");
					yield* type(g, "/hero brann");
					yield* type(g, "/map ford-road");
					yield* type(g, "/place brann b5");
					yield* frameWhere(
						g,
						"Brann's token",
						() => (g.view.map?.()?.tokens.length ?? 0) > 0
					);
					const [band, map] = [g.view.combat?.(), g.view.map?.()];
					yield* type(g, "just chatting");
					yield* frameWhere(g, "the chat", (f) =>
						f.includes("GM: just chatting")
					);
					expect(g.view.combat?.()).toBe(band);
					expect(g.view.map?.()).toBe(map);
					yield* type(g, "/dmg brann 1");
					yield* frameWhere(g, "the damage", (f) => f.includes("23/24"));
					expect(g.view.combat?.()).not.toBe(band);
					expect(g.view.map?.()).toBe(map);
				})
			)
	);

	effect(
		"an event keeps every prep item it leaves as it was, so only what changed is drawn",
		() =>
			atTable(
				Effect.gen(function* () {
					const g = yield* seat("gm");
					yield* reload(g.view);
					yield* waitFor(
						"the prep lists",
						() => g.view.prep?.view() !== undefined
					);
					const before = prepNow(g.view);
					yield* type(g, "/hero brann");
					yield* waitFor(
						"Brann in the party",
						() => g.view.prep?.view() !== before
					);
					const after = prepNow(g.view);

					const items = (v: typeof after, title: string) =>
						v.sections.find((s) => s.title === title)?.items ?? [];

					expect(items(after, "heroes").map((i) => i.label)).toEqual([
						"Ilsa",
						"Kesh",
						"Wren",
					]);

					for (const item of items(after, "heroes")) {
						expect(items(before, "heroes")).toContain(item);
					}

					expect(items(after, "monsters")).toBe(items(before, "monsters"));
					expect(after.maps).toBe(before.maps);
				})
			)
	);

	effect(
		"a loaded map the folder doesn't have is looked for once, not at every event",
		() =>
			atTable(
				Effect.gen(function* () {
					const content = yield* CampaignContent;
					let reads = 0;

					const counted = Effect.suspend(() => {
						reads += 1;

						return content.catalog;
					});

					const view = yield* openSeat({
						actor: "gm",
						room: "den",
						leave: () => {},
					}).pipe(
						Effect.provideService(CampaignContent, {
							...content,
							catalog: counted,
						})
					);

					const send = (line: string) =>
						Effect.promise(async () => await view.submit(line));

					yield* send("/map ford-road");
					yield* waitFor("the map", () => view.map?.() !== undefined);
					yield* Effect.promise(async () => {
						await rm(path.join(content.dir, "maps", "ford-road.txt"));
					});
					yield* reload(view);
					expect(reads).toBe(1);
					yield* send("/hero brann");
					yield* send("/add bandit-bruiser");
					yield* send("/dmg brann 1");
					yield* waitFor(
						"the damage",
						() => view.combat?.()?.combatants[0]?.stamina === 23
					);
					expect(reads).toBe(1);
					yield* send("/map new keep 7");
					yield* waitFor("the new map among the files", () => reads === 2);
					expect(view.prep?.view()?.maps.loaded?.name).toBeDefined();
				})
			)
	);

	effect(
		"a throw while following the room is logged with why, and the seat follows on",
		() =>
			atTable(
				Effect.gen(function* () {
					const { room, state, logs, view } = yield* overState("gm");
					const good = yield* room.state;

					const unreadable = Object.defineProperty({ ...good }, "ds", {
						get: () => {
							throw new Error("no ds here");
						},
					});

					yield* SubscriptionRef.set(state, unreadable);
					yield* waitFor("the log", () =>
						logs.some((l) => l.includes("no ds here"))
					);
					yield* SubscriptionRef.set(state, { ...good, seq: 99 });

					const shows = (text: string) => {
						try {
							return view.debug().includes(text);
						} catch {
							return false;
						}
					};

					yield* waitFor("the next state", () => shows('"seq": 99'));
				})
			)
	);

	effect(
		"a view that throws on one state is logged, keeps what it showed, and draws the next",
		() =>
			atTable(
				Effect.gen(function* () {
					const { room, state, logs, view } = yield* overState(alice);
					const good = yield* room.state;

					const noMap = Object.defineProperty({ ...good.ds }, "map", {
						get: () => {
							throw new Error("a map the seat can't read");
						},
					});

					yield* SubscriptionRef.set(state, { ...good, ds: noMap });
					yield* waitFor("the log", () =>
						logs.some((l) => l.includes("a map the seat can't read"))
					);
					expect(view.map?.()).toBeUndefined();

					const gm = yield* openSeat({
						actor: "gm",
						room: "den",
						leave: () => {},
					});

					expect(
						yield* Effect.promise(async () => await gm.submit("/map ford-road"))
					).toBeUndefined();
					yield* SubscriptionRef.set(state, yield* room.state);
					yield* waitFor(
						"the map",
						() => view.map?.()?.name === "The Ford Road"
					);
				})
			)
	);

	effect(
		"a throw while the table lays out is logged with why, said on the seat, and the next draws",
		() =>
			Effect.gen(function* () {
				const logs: Array<string> = [];

				const fake = fakeView({ myName: "Alice", combat: fight([vex]) });

				const t = yield* Effect.acquireRelease(
					Effect.promise(
						async () =>
							await createTestRenderer({
								width: 100,
								height: 30,
								exitOnCtrlC: false,
							})
					),
					(setup) =>
						Effect.sync(() => {
							setup.renderer.destroy();
						})
				);

				yield* mountTable(t.renderer, fake.view).pipe(
					Effect.provideService(
						Logger.CurrentLoggers,
						new Set([capturing(logs)])
					)
				);

				const unreadable = Object.defineProperty(fight([]), "combatants", {
					get: () => {
						throw new Error("no combatants here");
					},
				});

				fake.setCombat(unreadable);
				const seated = { t };
				yield* frameWhere(seated, "the line", (f) =>
					f.includes("this seat couldn't draw the table")
				);
				yield* waitFor("the log", () =>
					logs.some((l) => l.includes("no combatants here"))
				);
				fake.setCombat(
					fight([combatant({ id: "kor", name: "Kor", side: "heroes" })])
				);
				yield* frameWhere(
					seated,
					"the next band",
					(f) => f.includes("Kor") && !f.includes("couldn't")
				);
			})
	);

	effect(
		"draws the map from the room, with each seat's own hero and where it can reach",
		() =>
			atOpenTable(
				Effect.gen(function* () {
					const g = yield* seat("gm");
					const a = yield* seat(alice);
					expect(g.view.map?.()).toBeUndefined();
					yield* type(a, "Alice");
					yield* type(g, "/hero brann");
					yield* frameWhere(a, "Brann", (f) =>
						f.includes("Brann joins the party")
					);
					yield* type(a, "/play brann");
					yield* frameWhere(a, "Alice's hero", (f) =>
						f.includes("Alice takes Brann")
					);
					yield* type(g, "/map ford-road");
					yield* frameWhere(a, "the map's column letters", (f) =>
						f.includes("The Ford Road")
					);
					yield* type(a, "/place brann b5");
					yield* frameWhere(
						g,
						"Brann's token",
						() => (g.view.map?.()?.tokens.length ?? 0) > 0
					);
					const mine = a.view.map?.();
					expect(mine).toMatchObject({
						name: "The Ford Road",
						width: 20,
						height: 10,
					});
					expect(mine?.tokens).toEqual([
						{
							id: "brann",
							mark: "B",
							name: "Brann",
							x: 1,
							y: 4,
							side: "heroes",
							mine: true,
							acting: false,
							dead: false,
						},
					]);
					expect(mine?.reachLabel).toBe("Brann can reach: speed 5");
					const reach = new Set(mine?.reach.map((r) => `${r.x},${r.y}`));

					for (const x of [0, 2, 3, 4, 5, 6]) {
						expect(reach.has(`${x},4`)).toBe(true);
					}

					expect(reach.has("7,4")).toBe(false);
					expect(reach.has("1,1")).toBe(false);
					expect(g.view.map?.()?.tokens.map((t) => [t.mark, t.mine])).toEqual([
						["B", false],
					]);
					expect(g.view.map?.()?.reach).toEqual([]);
				})
			)
	);

	effect(
		"a stranger who names nobody at the door for 2 minutes is told so and sent off",
		() =>
			atTable(
				using(
					TestClock.layer(),
					Effect.gen(function* () {
						let left = 0;

						const t = yield* Effect.acquireRelease(
							Effect.promise(
								async () =>
									await createTestRenderer({
										width: 100,
										height: 30,
										exitOnCtrlC: false,
									})
							),
							(setup) =>
								Effect.sync(() => {
									setup.renderer.destroy();
								})
						);

						yield* knockSeat(t.renderer, {
							actor: alice,
							room: "den",
							fingerprint: "SHA256:aliceAAAAkeyfingerprint",
							bucket: "address:203.0.113.7",
							leave: () => {
								left += 1;
							},
						}).pipe(Effect.forkScoped);

						const seated = { t };
						yield* frameWhere(seated, "the door", (f) =>
							f.includes("knocking")
						);
						yield* TestClock.adjust(NAMING_TIMEOUT_MS - 1000);
						expect(left).toBe(0);
						yield* TestClock.adjust("1 second");
						yield* frameWhere(seated, "the closed door", (f) =>
							f.includes("Nobody knocked for 2 minutes")
						);
						expect(NAMING_TIMEOUT_TEXT).toContain(
							"Nobody knocked for 2 minutes"
						);
						yield* TestClock.adjust("4 seconds");
						yield* waitFor("the seat to leave", () => left === 1);
					})
				)
			)
	);
});

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const shown = (view: TableView) =>
	json({
		stage: view.stage?.(),
		party: view.party?.(),
		feed: view.feed(),
		present: view.present(),
		prep: view.prep?.view(),
		prepStage: view.prep?.stage?.(),
		gmNotes: view.gmNotes === undefined ? "none" : "some",
		problems: view.contentProblems?.(),
		debug: view.debug(),
	});

describe("GM notes at a seat", () => {
	const SECRET = "GMSECRET";

	effect(
		"a player's view of the stage, party and feed never holds a GM note; the GM's does",
		() =>
			Effect.gen(function* () {
				const dir = yield* campaignOf({
					...FULL,
					"events.jsonl": `${DOOR_OPEN_LINE}\n`,
				});

				yield* using(
					tableServices(dir),
					Effect.gen(function* () {
						for (const line of [
							"/show market",
							"/show mara",
							"/reveal ledger",
							"/show brass-key",
							"/pc rook",
							"/tracker alarm clock 4 The alarm",
							"/tracker alarm show",
							"/recap Rook came to the market.",
						]) {
							expect([line, (yield* runLine("gm", line)).kind]).toEqual([
								line,
								"done",
							]);
						}

						const player = yield* seat(alice);
						const gm = yield* seat("gm");

						yield* waitFor(
							"the stage at both seats",
							() =>
								player.view.stage?.()?.scene?.key === "scene:market" &&
								gm.view.stage?.()?.pinned.length === 2 &&
								gm.view.prep !== undefined
						);
						yield* reload(gm.view);

						const theirs = shown(player.view);

						expect(theirs).toContain("The Drowned Market");
						expect(theirs).toContain("Water laps at the boards.");
						expect(theirs).toContain("Mara Venn");
						expect(theirs).toContain("A torn ledger page");
						expect(theirs).toContain("Rook");
						expect(theirs).not.toContain(SECRET);
						expect(player.view.prep).toBeUndefined();
						expect(player.view.gmNotes).toBeUndefined();
						expect(player.view.contentProblems).toBeUndefined();
						expect(player.view.party?.().map((m) => m.name)).toEqual(["Rook"]);

						const frame = yield* Effect.promise(async () => {
							await player.t.renderOnce();

							return player.t.captureCharFrame();
						});

						expect(frame).toContain("The Drowned Market");
						expect(frame).not.toContain(SECRET);

						const notes = gm.view.gmNotes;

						expect(json(notes?.("scene:market"))).toContain(
							"GMSECRET the ledger is forged."
						);
						expect(json(notes?.("npc:mara"))).toContain(
							"GMSECRET she runs the smugglers."
						);
						expect(notes?.("handout:nowhere")).toBeUndefined();
						expect(
							(gm.view.prep?.stage?.() ?? []).map((section) => section.title)
						).toEqual(["scenes", "npcs", "handouts", "items"]);
					})
				);
			}),
		15_000
	);
});
