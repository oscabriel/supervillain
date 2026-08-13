/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-lane renderer snapshots. */
import { expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";
import { CORE_MAP_LOADED } from "@supervillain/core";
import type { Envelope, ViewEntry } from "@supervillain/core";

import { runChrome } from "../src/chrome.js";

const ACTOR = "snapshot-actor";

const entry: ViewEntry<unknown, unknown, unknown> = {
	model: { apply: (state) => state, init: () => ({}) },
	view: {
		createPanels: () => [],
		notices: [
			{ runs: [{ text: "the room is quiet", token: "muted" }] },
			{ runs: [{ text: "waiting for the next move", token: "primary" }] },
		],
		renderEvent: () => null,
	},
};

const mapEnvelope: Envelope = {
	actor: ACTOR,
	payload: {
		legend: { "#": "wall", ".": "floor" },
		name: "snapshot hall",
		rows: ["######", "#....#", "######"],
	},
	roomId: "snapshot-room",
	seq: 1,
	ts: 0,
	type: CORE_MAP_LOADED,
};

const fixture = () => {
	const pending: Envelope[] = [];
	let wake: (() => void) | undefined;
	const stream = async function* stream(): AsyncGenerator<Envelope> {
		for (;;) {
			const next = pending.shift();
			if (next === undefined) {
				// oxlint-disable-next-line promise/avoid-new, eslint/no-await-in-loop, eslint/no-loop-func -- fixture signal captures this fixture's wake slot.
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			yield next;
		}
	};
	return {
		push(envelope: Envelope) {
			pending.push(envelope);
			wake?.();
			wake = undefined;
		},
		session: {
			actor: ACTOR,
			close() {},
			input: {} as NodeJS.ReadStream,
			onClose: () => () => {},
			onResize: () => () => {},
			output: {} as NodeJS.WriteStream,
			size: () => ({ columns: 80, rows: 24 }),
		},
		store: {
			stream: () => stream(),
			submit: () => Promise.resolve({ accepted: true, envelopes: [] }),
		},
	};
};

const TERMINAL_SIZES = [
	{ height: 24, label: "80x24", width: 80 },
	{ height: 40, label: "120x40", width: 120 },
	{ height: 30, label: "160x30-wide", width: 160 },
] as const;

const SNAPSHOT_CASES = TERMINAL_SIZES.flatMap((size) =>
	[false, true].flatMap((hasMap) =>
		[false, true].map((focusMarker) => ({
			description: `${size.label}, ${hasMap ? "with" : "without"} Map, focus marker ${focusMarker ? "on" : "off"}`,
			focusMarker,
			hasMap,
			size,
		}))
	)
);

test.each(SNAPSHOT_CASES)(
	"$description",
	async ({ focusMarker, hasMap, size }) => {
		const setup = await createTestRenderer({
			height: size.height,
			width: size.width,
		});
		const probe = fixture();
		const exited = runChrome({
			entry,
			gameId: "fake",
			renderer: setup.renderer,
			roomLabel: "snapshot table",
			session: probe.session,
			store: probe.store,
			viewOptions: { focusMarker },
		});
		await setup.waitForFrame((frame) => frame.includes("snapshot table"));
		if (hasMap) {
			probe.push(mapEnvelope);
			await setup.waitForFrame((frame) => frame.includes("map · snapshot"));
		}

		expect(setup.captureCharFrame()).toMatchSnapshot();

		setup.renderer.destroy();
		await exited;
	}
);
