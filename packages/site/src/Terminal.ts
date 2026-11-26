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
import {
	dressingAt,
	figureOfFighter,
	MEK_REACH_BG,
	MEK_SIDES,
	mekSvg,
	swatchOf,
} from "./Mekmode.ts";
import { Message } from "./Model.ts";
import type { Key, MapMode } from "./Model.ts";
import { bodyOf, isDead, movesLeft, reachable, statusOf } from "./Rules.ts";
import type { FeedLine, TableState } from "./Rules.ts";
import { isStrikable, projectionOf, suggestionsOf } from "./Table.ts";
import type { Demo, Reply } from "./Table.ts";

const FEED_LINES = 12;

const METER = 6;

const REACH_FG = "#8ed1c8";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const ALWAYS: ReadonlyArray<string> = ["/roll 2d10+2", "/help"];

const KEYS: ReadonlyArray<Key> = ["ArrowUp", "ArrowDown", "Escape"];

const keyOf = (key: string): Option.Option<Message> => {
	const found = KEYS.find((known) => known === key);

	return found === undefined
		? Option.none()
		: Option.some(Message.PressedKey({ key: found }));
};

const classes = (names: ReadonlyArray<string>): string =>
	names.filter((name) => name !== "").join(" ");

const meterOf = (stamina: number, max: number): string => {
	const filled = Math.round((METER * Math.max(0, stamina)) / max);

	return `${"█".repeat(filled)}${"░".repeat(METER - filled)}`;
};

const healthOf = (state: TableState, id: string): string => {
	const status = statusOf(state, id);

	return status === "" ? "healthy" : status;
};

const turnText = (state: TableState): string => {
	if (state.winner !== "") {
		return "combat over";
	}

	return state.turn === ""
		? "between turns"
		: `${FIGHTERS.find((f) => f.id === state.turn)?.name ?? ""}'s turn`;
};

const titleView = (h: HtmlBuilder<Message>, key: string, text: string): Html =>
	h.div([h.Class("tui-box-title")], [h.span([h.Class("k")], [key]), text]);

const headerView = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("tui-header")],
		[
			h.span([h.Class("tui-brand")], ["supervillain"]),
			h.span([h.Class("tui-dim")], [" · "]),
			h.span([h.Class("tui-room")], ["first-fight"]),
			h.span([h.Class("tui-dim")], ["   here: "]),
			h.span([h.Class("tui-gm")], ["GM"]),
			h.span([h.Class("tui-dim")], [", "]),
			h.span([h.Class("tui-you")], ["Brann (you)"]),
		]
	);

const bandRowView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	fighter: Fighter
): Html => {
	const stamina = bodyOf(state, fighter.id)?.stamina ?? fighter.stamina;
	const status = healthOf(state, fighter.id);
	const hero = fighter.id === HERO;

	const meta = hero
		? `${status} · wrath ${state.wrath} · rec ${state.recoveries}`
		: `${status} · stab ${fighter.stability}`;

	return h.button(
		[
			h.Type("button"),
			h.Class(classes(["tui-band-row", status === "dead" ? "dead" : ""])),
			h.Title(`Inspect ${fighter.name}`),
			h.OnClick(Message.ClickedSuggestion({ line: `/sheet ${fighter.id}` })),
		],
		[
			hero
				? h.span(
						[h.Class("tui-mine-pill")],
						[`${fighter.mark} ${fighter.name} (you)`]
					)
				: h.span(
						[h.Class("tui-foe-name")],
						[`${fighter.mark} ${fighter.name}`]
					),
			h.span(
				[h.Class(`tui-meter ${status}`), h.AriaHidden(true)],
				[meterOf(stamina, fighter.stamina)]
			),
			h.span([], [`${stamina}/${fighter.stamina}`]),
			h.span([h.Class("tui-band-meta")], [meta]),
		]
	);
};

const bandView = (h: HtmlBuilder<Message>, state: TableState): Html =>
	h.section(
		[
			h.Class(classes(["tui-box", state.winner === "" ? "active-combat" : ""])),
			h.AriaLabel("The band"),
		],
		[
			titleView(h, "¹", `fight · round ${state.round} · ${turnText(state)}`),
			h.div(
				[h.Class("tui-band-grid")],
				[
					h.div(
						[h.Class("tui-band-col")],
						FIGHTERS.filter((fighter) => fighter.id === HERO).map((fighter) =>
							bandRowView(h, state, fighter)
						)
					),
					h.div(
						[h.Class("tui-band-col")],
						FIGHTERS.filter((fighter) => fighter.id !== HERO).map((fighter) =>
							bandRowView(h, state, fighter)
						)
					),
				]
			),
		]
	);

const floorGlyphOf = (terrain: string, isReach: boolean): string => {
	if (terrain === "~") {
		return "~";
	}

	return isReach ? "•" : "·";
};

const sideColorOf = (id: string, dead: boolean): string => {
	if (dead) {
		return MEK_SIDES.dead;
	}

	return id === HERO ? MEK_SIDES.you : MEK_SIDES.foe;
};

interface SquareInput {
	readonly name: string;
	readonly terrain: string;
	readonly dressed: string;
	readonly fg: string;
	readonly bg: string;
	readonly picture: boolean;
}

const wallView = (h: HtmlBuilder<Message>, input: SquareInput): Html =>
	h.span(
		[
			h.Class(classes(["tui-cell wall", input.picture ? "" : "text-mode"])),
			h.Style({ "--cell-bg": input.bg, "--cell-fg": input.fg }),
			h.AriaHidden(true),
		],
		[input.picture ? mekSvg(h, input.dressed, input.fg, "tui-tile-svg") : "█"]
	);

const tokenView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	input: SquareInput,
	id: string,
	dead: boolean
): Html => {
	const fighter = FIGHTERS.find((f) => f.id === id);
	const name = fighter?.name ?? "";
	const mark = dead ? "x" : (fighter?.mark ?? "?");
	const color = sideColorOf(id, dead);
	const label = `${input.name}, ${name}${dead ? ", dead" : ""}`;

	return h.button(
		[
			h.Type("button"),
			h.Tabindex(-1),
			h.Class(
				classes([
					"tui-cell",
					input.picture ? "" : "text-mode",
					id === HERO ? "you" : "",
					isStrikable(state, id) ? "attack" : "",
					dead ? "dead" : "",
				])
			),
			h.Style({ "--cell-bg": input.bg, "--cell-fg": color }),
			h.AriaLabel(label),
			h.Title(label),
			h.OnClick(Message.ClickedToken({ id })),
		],
		[
			input.picture
				? mekSvg(h, figureOfFighter(id), color, "tui-tile-svg")
				: mark,
		]
	);
};

const floorView = (
	h: HtmlBuilder<Message>,
	input: SquareInput,
	isReach: boolean
): Html => {
	const fg = isReach ? REACH_FG : input.fg;

	return h.button(
		[
			h.Type("button"),
			h.Tabindex(-1),
			h.Class(
				classes([
					"tui-cell",
					input.picture ? "" : "text-mode",
					isReach ? "reach" : "",
				])
			),
			h.Style({
				"--cell-bg": isReach ? MEK_REACH_BG : input.bg,
				"--cell-fg": fg,
			}),
			h.AriaLabel(input.name),
			h.Title(isReach ? `Move Brann to ${input.name}` : input.name),
			h.OnClick(Message.ClickedSquare({ square: input.name })),
		],
		[
			input.picture
				? mekSvg(h, input.dressed, fg, "tui-tile-svg")
				: floorGlyphOf(input.terrain, isReach),
		]
	);
};

const squareView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	open: ReadonlySet<string>,
	square: Square,
	mapMode: MapMode
): Html => {
	const name = nameOfSquare(square);
	const terrain = terrainAt(state.terrain, square);
	const dressed = dressingAt(square, terrain);
	const swatch = swatchOf(dressed);

	const input: SquareInput = {
		name,
		terrain,
		dressed,
		fg: swatch.fg,
		bg: swatch.bg,
		picture: mapMode === "pictures",
	};

	if (terrain === "#") {
		return wallView(h, input);
	}

	const here = state.bodies.filter(
		(body) => body.at.x === square.x && body.at.y === square.y
	);

	const living = here.find((body) => !isDead(state, body.id));
	const token = living ?? here[0];

	return token === undefined
		? floorView(h, input, open.has(name))
		: tokenView(h, state, input, token.id, living === undefined);
};

const mapHintOf = (state: TableState): string => {
	if (state.winner !== "") {
		return "click reset to play again";
	}

	const strike = FIGHTERS.some((fighter) => isStrikable(state, fighter.id));

	return `click a tinted square to move${strike ? " · click adjacent bandit to strike" : ""}`;
};

const mapView = (
	h: HtmlBuilder<Message>,
	state: TableState,
	mapMode: MapMode
): Html => {
	const open = new Set(reachable(state).map(nameOfSquare));
	const columns = Array.from({ length: COLUMNS }, (_unused, x) => x);
	const rows = Array.from({ length: ROWS }, (_unused, y) => y);

	const title =
		state.turn === HERO && state.winner === ""
			? `${MAP_NAME} · ${movesLeft(state)} move`
			: MAP_NAME;

	return h.section(
		[h.Class("tui-box tui-map-box"), h.AriaLabel("The map")],
		[
			titleView(h, "²", title),
			h.div(
				[h.Class("tui-grid-center")],
				[
					h.div(
						[h.Class("tui-grid")],
						[
							h.div([h.Class("tui-col-hdr")], []),
							...columns.map((x) =>
								h.div([h.Class("tui-col-hdr")], [LETTERS[x] ?? ""])
							),
							...rows.flatMap((y) => [
								h.div([h.Class("tui-row-hdr")], [String(y + 1)]),
								...columns.map((x) =>
									squareView(h, state, open, { x, y }, mapMode)
								),
							]),
						]
					),
				]
			),
			h.div(
				[h.Class("tui-map-foot")],
				[
					h.span([], ["B Brann · b Bruiser · s Slinger"]),
					h.span([], [mapHintOf(state)]),
				]
			),
		]
	);
};

const feedLineView = (h: HtmlBuilder<Message>, line: FeedLine): Html => {
	const parts: Array<Html | string> = [];

	if (line.who !== "") {
		parts.push(
			h.span(
				[h.Class(line.who === "GM" ? "who gm" : "who")],
				[`${line.who}${line.kind === "chat" ? ":" : ""} `]
			)
		);
	}

	parts.push(line.text);

	return h.div(
		[
			h.Class(classes(["tui-fline", line.taken ? "is-taken" : ""])),
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
		[
			h.Class("tui-box tui-feed-box"),
			h.AriaLabel("The feed"),
			h.AriaLive("polite"),
		],
		[
			titleView(h, "³", "feed"),
			h.div(
				[h.Class("tui-feed-scroll")],
				feed
					.slice(-FEED_LINES)
					.toReversed()
					.map((line) => feedLineView(h, line))
			),
		]
	);

const replyView = (h: HtmlBuilder<Message>, reply: Reply): Html =>
	h.section(
		[h.Class("tui-reply-box"), h.AriaLabel("Reply")],
		[
			h.div([h.Class("tui-reply-title")], [`just for you · ${reply.title}`]),
			h.button(
				[
					h.Type("button"),
					h.Class("tui-reply-close"),
					h.AriaLabel("Close"),
					h.OnClick(Message.ClickedCloseReply()),
				],
				["Esc"]
			),
			h.div(
				[h.Class("tui-reply-lines")],
				reply.lines.map((line) => h.div([], [line]))
			),
		]
	);

const leadOf = (state: TableState): string => {
	if (state.winner !== "") {
		return "combat over";
	}

	const main = state.acted ? "main spent" : "main ready";

	return `${movesLeft(state)} move · ${main}`;
};

const leadView = (
	h: HtmlBuilder<Message>,
	demo: Demo,
	state: TableState
): Html => {
	if (demo.refusal !== "") {
		return h.span(
			[h.Class("tui-lead-badge is-refusal"), h.AriaLive("polite")],
			[demo.refusal]
		);
	}

	return h.span(
		[h.Class("tui-lead-badge"), h.AriaLive("polite")],
		[leadOf(state)]
	);
};

const quickLinesOf = (demo: Demo, state: TableState): ReadonlyArray<string> => {
	if (state.winner !== "") {
		return ["/reset", "gg, all", "/roll 2d10+2", "/help"];
	}

	const base = suggestionsOf(demo);
	const hasRoll = base.some((line) => line.startsWith("/roll "));

	const extra = hasRoll
		? ALWAYS.filter((line) => !line.startsWith("/roll "))
		: ALWAYS;

	return [...new Set([...base, ...extra])];
};

const hintRowView = (
	h: HtmlBuilder<Message>,
	demo: Demo,
	state: TableState
): Html =>
	h.div(
		[h.Class("tui-hint-row")],
		[
			h.div(
				[h.Class("tui-hint-left")],
				[
					leadView(h, demo, state),
					h.span([h.Class("tui-dim")], ["·"]),
					h.div(
						[h.Class("tui-quick-links")],
						quickLinesOf(demo, state).map((line, index) =>
							h.button(
								[
									h.Type("button"),
									h.Class(
										classes(["tui-qcmd", index === 0 ? "suggested" : ""])
									),
									h.OnClick(Message.ClickedSuggestion({ line })),
								],
								[line]
							)
						)
					),
				]
			),
		]
	);

export interface TerminalOptions {
	readonly autoplay?: boolean;
	readonly autoplayLine?: string;
}

const inputView = (
	h: HtmlBuilder<Message>,
	demo: Demo,
	autoplay: boolean,
	autoplayLine: string
): Html => {
	const previewing = autoplay && autoplayLine !== "";

	return h.form(
		[
			h.Class(classes(["tui-input-form", previewing ? "is-preview" : ""])),
			h.OnSubmit(Message.SubmittedLine()),
		],
		[
			h.label([h.For("demo-line"), h.Class("tui-prompt")], [">"]),
			h.input([
				h.Id("demo-line"),
				h.Class("tui-input"),
				h.Type("text"),
				h.Value(previewing ? autoplayLine : demo.line),
				h.Placeholder("say something, or /help"),
				h.Autocomplete("off"),
				h.Spellcheck(false),
				h.AriaLabel("The input line"),
				h.OnFocus(Message.PausedAutoplay()),
				h.OnInput((line) => Message.TypedLine({ line })),
				h.OnKeyDownPreventDefault(keyOf),
			]),
			h.span([h.Class("tui-enter-hint"), h.AriaHidden(true)], ["Enter"]),
		]
	);
};

export const terminalView = (
	demo: Demo,
	h: HtmlBuilder<Message>,
	mapMode: MapMode = "pictures",
	options: TerminalOptions = {}
): Html => {
	const autoplay = options.autoplay ?? false;
	const autoplayLine = options.autoplayLine ?? "";
	const { state, feed } = projectionOf(demo);

	const screen: Array<Html> = [
		headerView(h),
		bandView(h, state),
		h.div(
			[h.Class("tui-mid")],
			[mapView(h, state, mapMode), feedView(h, feed)]
		),
	];

	if (demo.reply !== null) {
		screen.push(replyView(h, demo.reply));
	}

	screen.push(
		hintRowView(h, demo, state),
		inputView(h, demo, autoplay, autoplayLine)
	);

	return h.section(
		[
			h.Class("term-bleed"),
			h.Id("table"),
			h.AriaLabel("Interactive supervillain terminal"),
		],
		[h.div([h.Class("tui")], screen)]
	);
};
