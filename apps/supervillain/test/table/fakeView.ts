import { ifDefined, when } from "@supervillain/domain";
import { createSignal } from "solid-js";

import type {
	CombatView,
	FeedLine,
	MapView,
	PrepView,
	Present,
	TableView,
	TokenAction,
} from "../../src/table/view.ts";

export interface FakeViewOptions {
	readonly me?: string;
	readonly room?: string;
	readonly feed?: ReadonlyArray<FeedLine>;
	readonly present?: ReadonlyArray<Present>;
	readonly myName?: string | undefined;
	readonly reply?: (
		line: string
	) => string | undefined | Promise<string | undefined>;
	readonly complete?: (line: string) => ReadonlyArray<string>;
	readonly debug?: string;
	readonly joinHint?: string;
	readonly alert?: string | null;
	readonly combat?: CombatView | null;
	readonly map?: MapView | null;
	readonly actions?: (id: string) => ReadonlyArray<TokenAction> | undefined;
	readonly prep?: PrepView | null;
	readonly prepProblem?: string;
}

export const fakeView = (options: FakeViewOptions = {}) => {
	const [feed, setFeed] = createSignal<ReadonlyArray<FeedLine>>(
		options.feed ?? []
	);

	const [present, setPresent] = createSignal<ReadonlyArray<Present>>(
		options.present ?? []
	);

	const [myName, setMyName] = createSignal<string | undefined>(options.myName);

	const [combat, setCombat] = createSignal<CombatView | undefined>(
		options.combat ?? undefined
	);

	const [map, setMap] = createSignal<MapView | undefined>(
		options.map ?? undefined
	);

	const [alert, setAlert] = createSignal<string | undefined>(
		options.alert ?? undefined
	);

	const [prep, setPrep] = createSignal<PrepView | undefined>(
		options.prep ?? undefined
	);

	let reloads = 0;
	const submitted: Array<string> = [];
	const completed: Array<string> = [];
	let left = 0;

	const view: TableView = {
		me: options.me ?? "key:SHA256:alice",
		room: options.room ?? "den",
		feed,
		present,
		myName,
		submit: async (line) => {
			submitted.push(line);

			return await options.reply?.(line);
		},
		complete: (line) => {
			completed.push(line);

			return options.complete?.(line) ?? [];
		},
		debug: () => options.debug ?? "{}",
		leave: () => {
			left += 1;
		},
		...ifDefined(options.joinHint, (value) => ({ joinHint: value })),
		...when(options.combat !== undefined, () => ({ combat })),
		...when(options.map !== undefined, () => ({ map })),
		...when(options.alert !== undefined, () => ({ alert })),
		...ifDefined(options.actions, (value) => ({ actions: value })),
		...when(options.prep !== undefined, () => ({
			prep: {
				view: prep,
				reload: async () => {
					reloads += 1;

					return await Promise.resolve(options.prepProblem);
				},
			},
		})),
	};

	return {
		view,
		submitted,
		completed,
		left: () => left,
		setFeed,
		setPresent,
		setMyName,
		setCombat,
		setMap,
		setAlert,
		setPrep,
		reloads: () => reloads,
	};
};

export const line = (
	seq: number,
	who: string,
	text: string,
	kind = "chat"
): FeedLine => ({
	seq,
	who,
	kind,
	text,
	gm: false,
});

export const gm: Present = { actor: "gm", label: "Oscar", gm: true };

export const alice: Present = {
	actor: "key:SHA256:alice",
	label: "Alice",
	gm: false,
};

export const bob: Present = {
	actor: "key:SHA256:bob",
	label: "Bob",
	gm: false,
};
