import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
	COLUMNS,
	FIGHTERS,
	HERO,
	MAP_NAME,
	nameOfSquare,
	ROWS,
	terrainAt,
} from "./Encounter.ts";
import type { Fighter, Square } from "./Encounter.ts";
import { Message } from "./Model.ts";
import type { Key } from "./Model.ts";
import {
	bodyOf,
	isDead,
	lineOf,
	movesLeft,
	reachable,
	statusOf,
} from "./Rules.ts";
import type { FeedLine, TableState } from "./Rules.ts";
import { hintOf, projectionOf, suggestionsOf } from "./Table.ts";
import type { Demo, Reply } from "./Table.ts";

const FEED_LINES = 12;

const LOG_LINES = 8;

const METER = 10;

const KEYS: ReadonlyArray<Key> = ["ArrowUp", "ArrowDown", "Escape"];

const keyOf = (key: string): Option.Option<Message> => {
	const found = KEYS.find((known) => known === key);

	return found === undefined
		? Option.none()
		: Option.some(Message.PressedKey({ key: found }));
};

const classes = (names: ReadonlyArray<string>): string =>
	names.filter((name) => name !== "").join(" ");

const titleView = (
	h: HtmlBuilder<Message>,
	number: string,
	text: string,
	more: string
): Html => {
	const parts = [
		h.span([h.Class("panel-key")], [number]),
		h.span([h.Class("panel-name")], [text]),
	];

	if (more !== "") {
		parts.push(h.span([h.Class("panel-more")], [more]));
	}

	return h.p([h.Class("panel-title")], parts);
};

const meterOf = (stamina: number, max: number): string => {
	const filled = Math.round((METER * Math.max(0, stamina)) / max);

	return `${"█".repeat(filled)}${"░".repeat(METER - filled)}`;
};

const turnText = (state: TableState): string => {
	if (state.winner !== "") {
		return "combat over";
	}

	return state.turn === ""
		? "between turns"
		: `${FIGHTERS.find((f) => f.id === state.turn)?.name ?? ""}'s turn`;
};

const bandRowView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	fighter: Fighter
): Html => {
	const stamina = bodyOf(state, fighter.id)?.stamina ?? fighter.stamina;
	const status = statusOf(state, fighter.id);
	const hero = fighter.id === HERO;

	const extra = hero
		? `wrath ${state.wrath} · rec ${state.recoveries}`
		: `stability ${fighter.stability}`;

	return h.li(
		[
			h.Class(
				classes([
					"band-row",
					hero ? "is-you" : "is-foe",
					state.turn === fighter.id ? "is-acting" : "",
					status === "dead" ? "is-dead" : "",
				])
			),
		],
		[
			h.span([h.Class("band-mark")], [fighter.mark]),
			h.span(
				[h.Class("band-name")],
				[hero ? `${fighter.name} · you` : fighter.name]
			),
			h.span(
				[h.Class("band-meter"), h.AriaHidden(true)],
				[meterOf(stamina, fighter.stamina)]
			),
			h.span([h.Class("band-stamina")], [`${stamina}/${fighter.stamina}`]),
			h.span([h.Class("band-status")], [status]),
			h.span([h.Class("band-extra")], [extra]),
		]
	);
};

const bandView = (h: HtmlBuilder<Message>, state: TableState): Html =>
	h.section(
		[h.Class("panel lineup"), h.AriaLabel("The band")],
		[
			titleView(h, "¹", "fight", `round ${state.round} · ${turnText(state)}`),
			h.ol(
				[h.Class("band-rows")],
				FIGHTERS.map((fighter) => bandRowView(h, state, fighter))
			),
		]
	);

const glyphOf = (terrain: string, isReach: boolean): string => {
	if (terrain === "#") {
		return "█";
	}

	if (terrain === "~") {
		return isReach ? "≈" : "~";
	}

	return isReach ? "•" : "·";
};

const squareView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	open: ReadonlySet<string>,
	square: Square
): Html => {
	const name = nameOfSquare(square);
	const terrain = terrainAt(state.terrain, square);

	const living = state.bodies.find(
		(body) =>
			body.at.x === square.x &&
			body.at.y === square.y &&
			!isDead(state, body.id)
	);

	const fallen = state.bodies.find(
		(body) => body.at.x === square.x && body.at.y === square.y
	);

	const token = living ?? fallen;
	const isReach = open.has(name);

	if (terrain === "#") {
		return h.span([h.Class("sq is-wall"), h.AriaHidden(true)], ["█"]);
	}

	if (token !== undefined) {
		const fighter = FIGHTERS.find((f) => f.id === token.id);
		const dead = living === undefined;

		return h.button(
			[
				h.Type("button"),
				h.Tabindex(-1),
				h.Class(
					classes([
						"sq token",
						token.id === HERO ? "is-you" : "is-foe",
						state.turn === token.id ? "is-acting" : "",
						dead ? "is-dead" : "",
						terrain === "~" ? "is-rough" : "",
					])
				),
				h.AriaLabel(`${name}, ${fighter?.name ?? ""}${dead ? ", dead" : ""}`),
				h.OnClick(Message.ClickedToken({ id: token.id })),
			],
			[dead ? "x" : (fighter?.mark ?? "?")]
		);
	}

	return h.button(
		[
			h.Type("button"),
			h.Tabindex(-1),
			h.Class(
				classes([
					"sq",
					terrain === "~" ? "is-rough" : "",
					isReach ? "is-reach" : "",
				])
			),
			h.AriaLabel(name),
			h.OnClick(Message.ClickedSquare({ square: name })),
		],
		[glyphOf(terrain, isReach)]
	);
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const mapView = (h: HtmlBuilder<Message>, state: TableState): Html => {
	const open = new Set(reachable(state).map(nameOfSquare));
	const columns = Array.from({ length: COLUMNS }, (_unused, x) => x);
	const rows = Array.from({ length: ROWS }, (_unused, y) => y);

	return h.section(
		[h.Class("panel map"), h.AriaLabel("The map")],
		[
			titleView(
				h,
				"²",
				MAP_NAME,
				state.turn === HERO ? `${movesLeft(state)} movement left` : ""
			),
			h.div(
				[h.Class("grid"), h.Style({ "--columns": String(COLUMNS) })],
				[
					h.span([h.Class("edge corner"), h.AriaHidden(true)], [""]),
					...columns.map((x) =>
						h.span([h.Class("edge"), h.AriaHidden(true)], [LETTERS[x] ?? ""])
					),
					...rows.flatMap((y) => [
						h.span([h.Class("edge"), h.AriaHidden(true)], [String(y + 1)]),
						...columns.map((x) => squareView(h, state, open, { x, y })),
					]),
				]
			),
		]
	);
};

const replyView = (h: HtmlBuilder<Message>, reply: Reply): Html =>
	h.section(
		[h.Class("panel reply"), h.AriaLabel("Reply")],
		[
			h.div(
				[h.Class("reply-head")],
				[
					titleView(h, "⁴", reply.title, "just for you"),
					h.button(
						[
							h.Type("button"),
							h.Class("reply-close"),
							h.AriaLabel("Close"),
							h.OnClick(Message.ClickedCloseReply()),
						],
						["esc ×"]
					),
				]
			),
			h.div(
				[h.Class("reply-lines")],
				reply.lines.map((line) => h.p([], [line]))
			),
		]
	);

const feedLineView = (h: HtmlBuilder<Message>, line: FeedLine): Html => {
	const parts: Array<Html | string> = [];

	if (line.who !== "") {
		parts.push(
			h.span(
				[h.Class("feed-who")],
				[`${line.who}${line.kind === "chat" ? ":" : ""} `]
			)
		);
	}

	parts.push(line.text);

	return h.p(
		[
			h.Class(classes(["feed-line", line.taken ? "is-taken" : ""])),
			h.DataAttribute("kind", line.kind),
		],
		parts
	);
};

const feedView = (
	h: HtmlBuilder<Message>,
	feed: ReadonlyArray<FeedLine>
): Html =>
	h.section(
		[h.Class("panel feed"), h.AriaLabel("The feed"), h.AriaLive("polite")],
		[
			titleView(h, "³", "feed", ""),
			h.div(
				[h.Class("feed-lines")],
				feed.slice(-FEED_LINES).map((line) => feedLineView(h, line))
			),
		]
	);

const logView = (h: HtmlBuilder<Message>, demo: Demo): Html =>
	h.section(
		[h.Class("panel log"), h.AriaLabel("events.jsonl")],
		[
			titleView(h, "$", "tail events.jsonl", `${demo.log.length} lines`),
			h.pre(
				[h.Class("log-lines")],
				[
					h.code(
						[],
						demo.log.slice(-LOG_LINES).map((entry) => `${lineOf(entry)}\n`)
					),
				]
			),
		]
	);

const inputView = (h: HtmlBuilder<Message>, demo: Demo): Html =>
	h.form(
		[h.Class("input"), h.OnSubmit(Message.SubmittedLine())],
		[
			h.label([h.For("demo-line"), h.Class("input-prompt")], [">"]),
			h.input([
				h.Id("demo-line"),
				h.Type("text"),
				h.Value(demo.line),
				h.Placeholder("type here: chat, or a /command"),
				h.Autocomplete("off"),
				h.Spellcheck(false),
				h.AriaLabel("The input line"),
				h.OnInput((line) => Message.TypedLine({ line })),
				h.OnKeyDownPreventDefault(keyOf),
			]),
		]
	);

const chipsView = (h: HtmlBuilder<Message>, demo: Demo): Html =>
	h.div(
		[h.Class("chips")],
		[
			h.span([h.Class("chips-label")], ["try"]),
			...suggestionsOf(demo).map((line) =>
				h.button(
					[
						h.Type("button"),
						h.Class("chip"),
						h.OnClick(Message.ClickedSuggestion({ line })),
					],
					[line]
				)
			),
		]
	);

const toolsView = (h: HtmlBuilder<Message>, demo: Demo): Html =>
	h.div(
		[h.Class("tools")],
		[
			h.button(
				[
					h.Type("button"),
					h.Class("tool"),
					h.AriaPressed(demo.showLog ? "true" : "false"),
					h.OnClick(Message.ClickedLogToggle()),
				],
				[demo.showLog ? "hide events.jsonl" : "show events.jsonl"]
			),
			h.button(
				[
					h.Type("button"),
					h.Class("tool"),
					h.OnClick(Message.ClickedSuggestion({ line: "/help" })),
				],
				["/help"]
			),
			h.button(
				[
					h.Type("button"),
					h.Class("tool"),
					h.OnClick(Message.ClickedRestart()),
				],
				["start over"]
			),
		]
	);

const barView = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("term-bar")],
		[
			h.span(
				[h.Class("term-dots"), h.AriaHidden(true)],
				[h.i([], []), h.i([], []), h.i([], [])]
			),
			h.span([h.Class("term-command")], ["ssh -p 2222 ford@table.example.com"]),
		]
	);

const headView = (h: HtmlBuilder<Message>): Html =>
	h.p(
		[h.Class("term-head")],
		[
			h.span([h.Class("term-brand")], ["supervillain"]),
			h.span([], ["ford · draw-steel"]),
			h.span([h.Class("term-seat")], ["you are Brann"]),
		]
	);

const hintView = (h: HtmlBuilder<Message>, demo: Demo): Html =>
	h.p(
		[
			h.Class(classes(["hint", demo.refusal === "" ? "" : "is-refusal"])),
			h.AriaLive("polite"),
		],
		[demo.refusal === "" ? hintOf(demo) : demo.refusal]
	);

export const terminalView = (demo: Demo, h: HtmlBuilder<Message>): Html => {
	const { state, feed } = projectionOf(demo);

	const shown =
		demo.reply === null ? mapView(h, state) : replyView(h, demo.reply);

	const screen = [
		barView(h),
		headView(h),
		bandView(h, state),
		h.div([h.Class("term-body")], [shown, feedView(h, feed)]),
	];

	if (demo.showLog) {
		screen.push(logView(h, demo));
	}

	screen.push(hintView(h, demo), inputView(h, demo));

	return h.figure(
		[h.Class("demo"), h.Id("table")],
		[
			h.div([h.Class("term")], screen),
			chipsView(h, demo),
			toolsView(h, demo),
			h.figcaption(
				[],
				[
					"A model of the table, running in your browser: one hero against two bandits from the sample campaign, the real commands, and the log lines the table would write. Nothing here talks to a server. At a real table everyone sees the same fight, and the GM's machine runs it.",
				]
			),
		]
	);
};
