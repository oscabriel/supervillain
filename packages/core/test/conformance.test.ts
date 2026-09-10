/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite: the harness picks the runner. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decide } from "../../games/fake/src/authority.js";
import {
	PLEDGE_OWN_SEAT_REASON,
	apply,
	eventTypes,
	init,
	offers,
} from "../../games/fake/src/model.js";
import type {
	FakeCommand,
	FakeEvent,
	FakeState,
} from "../../games/fake/src/model.js";
import { view } from "../../games/fake/src/view.js";
import { RoomHost } from "../../room-host/src/index.js";
import { createTableFold } from "../../table/src/fold.js";
import type {
	Envelope,
	HostRegistry,
	TableView,
	ViewEntry,
} from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const registry: HostRegistry = {
	get: (gameId) =>
		gameId === "fake"
			? {
					authority: { decide },
					grammar: { eventTypes },
					model: { apply, init },
				}
			: undefined,
};

const table: TableView = {
	actor: "actor-guest",
	gmSeatId: "gm",
	seats: [
		{ actor: "actor-gm", characterId: null, id: "gm" },
		{ actor: "actor-guest", characterId: "hero", id: "guest" },
	],
};

describe("game module seam", () => {
	test("interleaves core and module envelopes in one log with opaque game state", () => {
		const log: Envelope[] = [
			{
				actor: "actor-gm",
				payload: { gameId: "fake" },
				seq: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				type: "core.room-created",
			},
			{
				actor: "actor-gm",
				payload: { seatId: "gm" },
				seq: 2,
				timestamp: "2026-01-01T00:00:01.000Z",
				type: "fake.seat-observed",
			},
		];
		const roomState: { game: unknown } = { game: init() };

		expect(log.map(({ type }) => type)).toEqual([
			"core.room-created",
			"fake.seat-observed",
		]);
		// oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round-trip IS the conformance assertion: game state must survive JSON serialization
		expect(JSON.parse(JSON.stringify(roomState))).toEqual(roomState);
	});

	test("init is deterministic and decide rejects, reads TableView, and emits multiple events", () => {
		expect(init()).toEqual(init());
		expect(
			decide(init(), { reason: "not now", type: "fake.reject" }, table)
		).toEqual({
			message: "not now",
			rejected: true,
		});
		expect(
			decide(init(), { seatId: "missing", type: "fake.visit" }, table)
		).toMatchObject({
			rejected: true,
		});
		expect(
			decide(init(), { seatId: "guest", type: "fake.visit" }, table)
		).toEqual([
			{
				characterId: "hero",
				seatId: "guest",
				type: "fake.seat-observed",
			},
			{ type: "fake.visit-counted", visits: 1 },
		]);
	});

	test("crosses character bindings through host decide and fresh replay", async () => {
		const folder = await mkdtemp(
			path.join(tmpdir(), "supervillain-conformance-")
		);
		try {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder: folder,
				gameId: "fake",
				registry,
			});
			await host.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			await host.submit({
				actor: "actor-guest",
				command: { characterId: "  hero  ", type: "core.bind-character" },
			});
			await host.submit({
				actor: "actor-guest",
				command: { seatId: "player-1", type: "fake.visit" },
			});
			const expected = host.snapshot();
			expect(expected.game).toEqual({
				lastCharacterId: "hero",
				lastSeatId: "player-1",
				standing: {},
				visits: 1,
			});

			const replayed = await RoomHost.open({
				campaignFolder: folder,
				registry,
			});
			expect(replayed.snapshot()).toEqual(expected);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}
	});

	test("panels render arrays and dispatch through their input", () => {
		const [panel] = view.createPanels();
		expect(panel).toBeDefined();
		if (panel === undefined) {
			return;
		}
		const dispatched: unknown[] = [];
		const input = {
			dispatch: (command: unknown) => dispatched.push(command),
			focused: false,
			state: init(),
			table,
		};
		expect(panel.render(input)).toEqual([
			{ runs: [{ text: "Visits: 0", token: "primary" }] },
		]);
		expect(panel.render({ ...input, focused: true })).toEqual([
			{ runs: [{ text: "Visits: 0 · q to visit", token: "primary" }] },
		]);
		expect(
			panel.onKey?.({ name: "q", text: "q" }, { ...input, focused: true })
		).toBe(true);
		expect(dispatched).toEqual([{ seatId: "guest", type: "fake.visit" }]);
	});

	test("replay is byte-identical", () => {
		const events: FakeEvent[] = [
			{
				characterId: "hero",
				seatId: "guest",
				type: "fake.seat-observed",
			},
			{ type: "fake.visit-counted", visits: 1 },
		];
		const replay = (): FakeState => {
			let state = init();
			for (const event of events) {
				state = apply(state, event);
			}
			return state;
		};

		expect(JSON.stringify(replay())).toBe(JSON.stringify(replay()));
	});
});

/** A standing decision opened in state by folding its own event — the shape
 * every test below starts from. */
const openStandingState = (decisionId = "decision-1"): FakeState =>
	apply(init(), {
		answers: ["yes", "no"],
		decisionId,
		kind: "double-visit",
		prompt: "Double this visit?",
		seatId: "guest",
		type: "fake.decision-opened",
	});

const foldEvents = (events: readonly FakeEvent[]): FakeState => {
	let state = init();
	for (const event of events) {
		state = apply(state, event);
	}
	return state;
};

describe("standing decisions and offers across the seam", () => {
	const gmTable: TableView = {
		actor: "actor-gm",
		gmSeatId: "gm",
		seats: table.seats,
	};
	const strangerTable: TableView = {
		actor: "actor-stranger",
		gmSeatId: "gm",
		seats: table.seats,
	};

	test("a pledge is a two-step command: the open decision is state, not a Panel's local buffer", () => {
		const emitted = decide(
			init(),
			{ seatId: "guest", type: "fake.pledge" },
			table
		);
		expect(Array.isArray(emitted)).toBe(true);
		if (!Array.isArray(emitted)) {
			return;
		}
		expect(emitted.map(({ type }) => type)).toEqual([
			"fake.seat-observed",
			"fake.visit-counted",
			"fake.decision-opened",
		]);
		const opened = emitted.at(-1);
		if (opened?.type !== "fake.decision-opened") {
			return;
		}
		// The decision carries what the glossary names: an id, a kind, and
		// the offered answers.
		expect(foldEvents(emitted).standing.guest).toEqual({
			answers: ["yes", "no"],
			decisionId: opened.decisionId,
			kind: "double-visit",
			prompt: "Double this visit?",
		});
	});

	test("a pledge for another seat is refused with the words the blocked offer shows", () => {
		// The rule lives once (ADR-0036): the reason a Panel renders on the
		// disabled action is the reason decide refuses with.
		expect(
			decide(init(), { seatId: "guest", type: "fake.pledge" }, strangerTable)
		).toEqual({ message: PLEDGE_OWN_SEAT_REASON, rejected: true });
		expect(
			decide(init(), { seatId: "guest", type: "fake.pledge" }, gmTable)
		).toEqual({ message: PLEDGE_OWN_SEAT_REASON, rejected: true });
	});

	test("a seat with a standing decision cannot open a second one", () => {
		expect(
			decide(
				openStandingState(),
				{ seatId: "guest", type: "fake.pledge" },
				table
			)
		).toMatchObject({ rejected: true });
	});

	test("an answer whose id is not the standing one is rejected", () => {
		expect(
			decide(
				openStandingState(),
				{
					answer: "yes",
					decisionId: "decision-stale",
					type: "fake.decision.answer",
				},
				table
			)
		).toEqual({
			message: "No standing decision 'decision-stale' is waiting.",
			rejected: true,
		});
	});

	test("a yes lands its own visit; declining and cancelling leave the pledge counted", () => {
		// The pledge already counted a visit; resolving it never undoes that
		// (ADR-0035: cancel cannot undo time already spent).
		const state = openStandingState();

		const yes = decide(
			state,
			{
				answer: "yes",
				decisionId: "decision-1",
				type: "fake.decision.answer",
			},
			table
		);
		expect(Array.isArray(yes)).toBe(true);
		if (Array.isArray(yes)) {
			expect(yes).toEqual([
				{
					answer: "yes",
					decisionId: "decision-1",
					type: "fake.decision-answered",
				},
				{ type: "fake.visit-counted", visits: 1 },
			]);
			const folded = foldEvents(yes);
			expect(folded.standing).toEqual({});
			expect(folded.visits).toBe(1);
		}

		const no = decide(
			state,
			{ answer: "no", decisionId: "decision-1", type: "fake.decision.answer" },
			table
		);
		expect(no).toEqual([
			{
				answer: "no",
				decisionId: "decision-1",
				type: "fake.decision-answered",
			},
		]);
		if (Array.isArray(no)) {
			expect(foldEvents(no).visits).toBe(0);
		}

		const cancelled = decide(
			state,
			{ decisionId: "decision-1", type: "fake.decision.cancel" },
			table
		);
		expect(cancelled).toEqual([
			{ decisionId: "decision-1", type: "fake.decision-cancelled" },
		]);
		if (Array.isArray(cancelled)) {
			expect(foldEvents(cancelled).standing).toEqual({});
		}
	});

	test("a seat answers its own decision, another seat cannot, and the GM can", () => {
		const command = {
			answer: "no",
			decisionId: "decision-1",
			type: "fake.decision.answer",
		} as const;
		expect(decide(openStandingState(), command, table)).not.toMatchObject({
			rejected: true,
		});
		expect(decide(openStandingState(), command, gmTable)).not.toMatchObject({
			rejected: true,
		});
		expect(decide(openStandingState(), command, strangerTable)).toMatchObject({
			rejected: true,
		});
	});

	test("every attemptable offer is accepted by decide on the same state", () => {
		// Both sides of the gate: the open table and a seat owing an answer.
		for (const state of [init(), openStandingState()]) {
			const attemptable = offers(state, table).filter(
				(offer) => offer.availability === "attemptable"
			);
			expect(attemptable.length).toBeGreaterThan(0);
			for (const offer of attemptable) {
				expect(decide(state, offer.command, table)).not.toMatchObject({
					rejected: true,
				});
			}
		}
	});

	test("a standing decision collapses the seat's offers to answering or declining it", () => {
		const list = offers(openStandingState(), table);
		expect(list).toEqual([
			{
				availability: "needsSelection",
				label: "Answer: Double this visit?",
				template: { decisionId: "decision-1", type: "fake.decision.answer" },
			},
			{
				availability: "attemptable",
				command: { decisionId: "decision-1", type: "fake.decision.cancel" },
				label: "Decline the standing decision",
			},
		]);
	});

	test("a blocked offer carries a reason and no runnable command", () => {
		const blocked = offers(init(), table).find(
			({ availability }) => availability === "blocked"
		);
		expect(blocked).toEqual({
			availability: "blocked",
			label: "Pledge for another seat",
			reason: PLEDGE_OWN_SEAT_REASON,
		});
	});

	test("a standing decision survives a host restart through fresh replay", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-standing-"));
		try {
			const host = await RoomHost.open({
				actor: "actor-gm",
				campaignFolder: folder,
				gameId: "fake",
				registry,
			});
			await host.submit({
				actor: "actor-guest",
				command: { type: "core.claim-seat" },
			});
			await host.submit({
				actor: "actor-guest",
				command: { seatId: "player-1", type: "fake.pledge" },
			});
			const expected = host.snapshot();
			expect(Object.keys(expected.game.standing)).toHaveLength(1);

			const replayed = await RoomHost.open({
				campaignFolder: folder,
				registry,
			});
			expect(replayed.snapshot()).toEqual(expected);

			// The reopened host still owes the answer: the decision is in the
			// replayed log, not in the dead process's memory.
			const decisionId = Object.values(expected.game.standing)[0]?.decisionId;
			if (decisionId === undefined) {
				throw new Error("no standing decision after pledge");
			}
			const answered = await replayed.submit({
				actor: "actor-guest",
				command: { answer: "yes", decisionId, type: "fake.decision.answer" },
			});
			expect(answered).toMatchObject({ accepted: true });
			expect(replayed.snapshot().game.visits).toBe(2);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}
	});
});

/** A permanent old-log fixture for the reference module, carrying the
 * pre-`characterId` `fake.seat-observed` shape beside the current one. */
const legacyLogPath = path.join(
	import.meta.dirname,
	"fixtures",
	"legacy-fake-log.jsonl"
);

const viewEntry: ViewEntry<FakeState, FakeCommand, FakeEvent> = {
	model: { apply, init },
	view,
};

const envelope = (
	type: `${string}.${string}`,
	payload: unknown,
	seq: number
): Envelope => ({
	actor: "actor-gm",
	payload,
	seq,
	timestamp: "2026-01-01T00:00:09.000Z",
	type,
});

describe("fold posture across the seam", () => {
	test("both folds replay a shipped legacy module shape green", async () => {
		const text = await readFile(legacyLogPath, "utf-8");
		const envelopes = text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Envelope);
		const expected: FakeState = {
			lastCharacterId: "hero",
			lastSeatId: "gm",
			standing: {},
			visits: 1,
		};
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-legacy-"));
		try {
			await writeFile(path.join(folder, "events.jsonl"), text);
			const host = await RoomHost.open({ campaignFolder: folder, registry });
			expect(host.snapshot().game).toEqual(expected);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}

		const fold = createTableFold(viewEntry, "fake", "actor-gm");
		for (const value of envelopes) {
			fold.apply(value);
		}
		expect(fold.endReplay()).toBeNull();
		expect(fold.skips()).toEqual([]);
		expect(fold.state()).toEqual(expected);
	});

	test("the writer fold halts on a module event outside the grammar", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "supervillain-unknown-"));
		try {
			await writeFile(
				path.join(folder, "events.jsonl"),
				`${[
					envelope("core.room-created", { gameId: "fake" }, 1),
					envelope("core.seat-claimed", { seatId: "gm" }, 2),
					envelope("fake.party-grown", { size: 3 }, 3),
				]
					.map((value) => JSON.stringify(value))
					.join("\n")}\n`
			);

			await expect(
				RoomHost.open({ campaignFolder: folder, registry })
			).rejects.toThrow(
				"Log contains unknown event type 'fake.party-grown' at line 3 — this host is too old."
			);
		} finally {
			await rm(folder, { force: true, recursive: true });
		}
	});

	test("the render fold skips the unknown tier silently and stays alive", () => {
		const fold = createTableFold(viewEntry, "fake", "actor-gm");
		fold.endReplay();
		expect(fold.apply(envelope("fake.party-grown", { size: 3 }, 3))).toBeNull();
		expect(
			fold.apply(envelope("core.written-by-a-newer-host", { name: "keep" }, 4))
		).toBeNull();
		expect(fold.skips()).toEqual([]);
		expect(
			fold.apply(envelope("fake.visit-counted", { visits: 2 }, 5))
		).toEqual({ runs: [{ text: "visit 2", token: "accent" }] });
	});

	test("the render fold skips the known-invalid tier loudly and stays alive", () => {
		const fold = createTableFold(viewEntry, "fake", "actor-gm");
		fold.endReplay();
		expect(fold.apply(envelope("fake.visit-counted", "nope", 6))).toEqual({
			runs: [
				{
					text: "⚠ skipped event #6 (fake.visit-counted): payload is not an object",
					token: "danger",
				},
			],
		});
		expect(
			fold.apply(envelope("fake.visit-counted", { visits: 2 }, 7))
		).toEqual({ runs: [{ text: "visit 2", token: "accent" }] });
	});

	test("the module's declared grammar covers every event its authority emits", () => {
		const emitted = decide(
			init(),
			{ seatId: "guest", type: "fake.visit" },
			table
		);
		expect(Array.isArray(emitted)).toBe(true);
		if (!Array.isArray(emitted)) {
			return;
		}
		for (const event of emitted) {
			expect(eventTypes as readonly string[]).toContain(event.type);
		}
	});
});
