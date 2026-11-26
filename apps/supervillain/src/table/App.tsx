import { decodePasteBytes } from "@opentui/core";
import type {
	BoxRenderable,
	KeyEvent,
	MouseEvent,
	PasteEvent,
	ScrollBoxRenderable,
} from "@opentui/core";
import {
	useKeyboard,
	usePaste,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/solid";
import { formatSquare, ifDefined } from "@supervillain/domain";
import {
	createEffect,
	createMemo,
	createSignal,
	ErrorBoundary,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import type { Accessor } from "solid-js";

import { Band } from "./Band.tsx";
import { Feed } from "./Feed.tsx";
import { hanging } from "./hanging.ts";
import { Header } from "./Header.tsx";
import { HintRow, showsWidth } from "./HintRow.tsx";
import {
	backspace,
	cancelCompletion,
	clearToStart,
	complete,
	deleteForward,
	deleteWordBack,
	emptyLine,
	fillLine,
	historyDown,
	historyUp,
	insert,
	insertWord,
	intentFor,
	keyAction,
	modeFor,
	moveEnd,
	moveHome,
	moveLeft,
	moveRight,
	NAME_PROMPT,
	PREP_IS_GMS,
	remember,
	restoreDraft,
	submitLine,
	tableCompletions,
} from "./input.ts";
import type {
	KeyAction,
	Layout,
	LineEditKind,
	Look,
	LineState,
	Slot,
} from "./input.ts";
import { InputLine } from "./InputLine.tsx";
import { KnockBanner } from "./KnockBanner.tsx";
import {
	bandRows,
	heights as layoutHeights,
	mapHeights,
	roomFor,
} from "./layout.ts";
import type { BandWant, Screen } from "./layout.ts";
import {
	focusOf,
	followed,
	MAP_FRAME,
	mapLayout,
	mapRowsWanted,
	tokenAt,
} from "./map.ts";
import type { Focus } from "./map.ts";
import { MapPane } from "./MapPane.tsx";
import {
	boxClick,
	choose,
	clickOutcome,
	isLeftButton,
	menuOf,
	menuRows,
	menuStands,
	wheel,
} from "./mouse.ts";
import type { Clicked, MenuItem, Selection } from "./mouse.ts";
import {
	ALL_SHOWN,
	allHiddenParts,
	hiddenPanels,
	panelKeys,
	panelsOf,
	marked,
	panelMark,
	panelNumber,
	togglePanel,
	viewPreset,
} from "./panels.ts";
import type { Panel, Panels } from "./panels.ts";
import { partyWanted, sheetLine } from "./party.ts";
import { Party } from "./Party.tsx";
import {
	GUTTER,
	LABEL_ROWS,
	pictureRowsWanted,
	pictureWindow,
	SQUARE,
} from "./picture.ts";
import { PictureMap, usePicturesShown } from "./PictureMap.tsx";
import {
	armedStands,
	placeNear,
	prepCount,
	prepHints,
	prepNext,
	prepWidth,
} from "./prep.ts";
import type { PrepArmed } from "./prep.ts";
import { Prep } from "./Prep.tsx";
import {
	campaignShown,
	codexFind,
	codexWanted,
	stagePlan,
	stageWanted,
} from "./stage.ts";
import type { CodexState, Peek, StagePlan } from "./stage.ts";
import { Stage } from "./Stage.tsx";
import { color, people } from "./theme.ts";
import type {
	KnockShown,
	MapView,
	PartyMember,
	PrepView,
	StageView,
	TableView,
} from "./view.ts";

const panelHint = (keys: string) => `${keys} show or hide panels`;

const keyHints = (keys: string) => [
	`Tab completes · ↑↓ history · PgUp/PgDn scroll · ${panelHint(keys)} · /help · Ctrl-C leaves`,
	"Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves",
	"Tab completes · ↑↓ history · /help · Ctrl-C leaves",
	"Tab completes · /help · Ctrl-C leaves",
	"Tab completes · /help",
	"",
];

const mapHints = (keys: string) => [
	`Tab completes · /view · ${panelHint(keys)} · /help · Ctrl-C leaves`,
	"Tab completes · /view · /help · Ctrl-C leaves",
	"/view · /help",
	"",
];

const CLIPPED_HINTS = {
	mine: ["/view map to see all your reach", "/view map", ""],
	theirs: ["/view map to see all of it", "/view map", ""],
} as const;

const SETUP_HINTS = [
	`Alt+${panelNumber("prep")} or /prep sets up a game in the prep panel · /help lists the commands`,
	`Alt+${panelNumber("prep")} or /prep sets up a game · /help lists the commands`,
	"/prep sets up a game · /help",
	"",
];

const playHints = (free: ReadonlyArray<string>) => [
	`free to play: ${free.join(", ")} · /play <name> takes one · /help`,
	`free to play: ${free.join(", ")} · /play <name>`,
	"/play <name> takes a free hero · /help",
	"/play <name>",
	"",
];

const turnHints = (hints: ReadonlyArray<string>) => [
	...hints.flatMap((h) =>
		h === "" ? [] : [`your turn · /done ends it · ${h}`]
	),
	"your turn · /done ends it",
	"your turn",
	"",
];

const NAME_HINT = "type the name you want, then Enter · Ctrl-C leaves";

const PANE_HINTS = [
	`Esc closes · Alt+${panelNumber("reply")} hides it · PgUp/PgDn scroll it · keep typing as usual`,
	"Esc closes · PgUp/PgDn scroll it · keep typing as usual",
	"Esc closes · PgUp/PgDn scroll it",
	"Esc closes",
	"",
];

const REPLY_HIDDEN = `your reply is hidden · Alt+${panelNumber("reply")} shows it · Esc drops it`;

const CONFIRM_LEAVE =
	"Players are still here. Ctrl-C again closes the table for everyone.";

const PAGE = 0.8;

const MIN_SEAT = { width: 72, height: 20 } as const;

const NO_MAP = "no map is loaded; the layout applies once one is";

const NO_BOARD = "no map is loaded, so there is no board to look at";

const NO_STAGE = "this table has no campaign stage";

const PEEKS: Readonly<Record<Slot, string>> = {
	stage: "you're looking at the stage · /view board goes back",
	board: "you're looking at the board · /view stage goes back",
};

const problemAlert = (problems: ReadonlyArray<string>): string | undefined => {
	if (problems.length === 0) {
		return undefined;
	}

	return problems.length === 1
		? "a campaign file has a problem · /prep shows it"
		: `campaign files have ${problems.length} problems · /prep shows them`;
};

const NO_REPLY = "no reply is open; /sheet or /help opens one";

const MOUSE_ON =
	"mouse on: click your token for what it can do, a panel's title to hide it · Shift+drag selects text";

const MOUSE_OFF =
	"mouse off: your terminal selects text as usual · /mouse on clicks again";

const said = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const LINE_EDITS = {
	historyUp,
	historyDown,
	backspace,
	delete: deleteForward,
	deleteWord: deleteWordBack,
	clearToStart,
	left: moveLeft,
	right: moveRight,
	home: moveHome,
	end: moveEnd,
} satisfies Record<LineEditKind, (s: LineState) => LineState>;

const isLineEdit = (
	action: KeyAction
): action is { readonly kind: LineEditKind } =>
	Object.hasOwn(LINE_EDITS, action.kind);

const Undrawn = (props: {
	error: unknown;
	reset: () => void;
	view: TableView;
}) => {
	const { view } = props;
	createEffect(
		on(
			() => [
				view.feed(),
				view.present(),
				view.combat?.(),
				view.map?.(),
				view.prep?.view(),
				view.stage?.(),
				view.party?.(),
			],
			() => {
				props.reset();
			},
			{ defer: true }
		)
	);

	const why = said(props.error);

	return (
		<box flexGrow={1} paddingLeft={1} paddingRight={1}>
			<text fg={color.notice} wrapMode="none">
				{`this seat couldn't draw the table (${why}) · it tries again at the next change`}
			</text>
		</box>
	);
};

export const App = (props: { view: TableView }) => {
	const { view } = props;
	const size = useTerminalDimensions();
	const [line, setLine] = createSignal<LineState>(emptyLine);
	const [notice, setNotice] = createSignal<string | undefined>();
	const [showDebug, setShowDebug] = createSignal(false);
	const [panels, setPanels] = createSignal<Panels>(ALL_SHOWN);

	const [pin, setPin] = createSignal<
		{ readonly square: Focus } | { readonly token: string }
	>();

	const [look, setLook] = createSignal<Look>("pictures");
	const picturesShown = usePicturesShown();
	const pictures = () => look() === "pictures" && picturesShown();
	const [mouse, setMouse] = createSignal(true);
	const [selection, setSelection] = createSignal<Selection>();
	const [armed, setArmed] = createSignal<PrepArmed>();
	const [peek, setPeek] = createSignal<Peek>();
	const [codex, setCodex] = createSignal<CodexState>();

	const [adding, setAdding] = createSignal<{
		readonly figure: string;
		readonly at: Focus;
		readonly before: ReadonlySet<string>;
	}>();

	const renderer = useRenderer();
	const leaving = () => notice() === CONFIRM_LEAVE;
	let hinted: { readonly line: string; readonly hint: string } | undefined;

	const asked = () =>
		hinted !== undefined && notice() === hinted.hint ? hinted.line : undefined;

	let queue: Promise<unknown> = Promise.resolve();
	let feed: ScrollBoxRenderable | undefined;
	let pane: ScrollBoxRenderable | undefined;
	let debug: ScrollBoxRenderable | undefined;
	let prepBox: ScrollBoxRenderable | undefined;
	let stageBox: ScrollBoxRenderable | undefined;
	const keys = panelKeys(view.prep !== undefined);

	const mode = () => modeFor(view.me, view.myName());
	const multiline = () => notice()?.includes("\n") ?? false;
	const paneOpen = () => multiline() && panels().reply;
	const noticeLine = () => notice() !== undefined && !paneOpen();

	const edit = (f: (s: LineState) => LineState) => {
		setLine(f(line()));
	};

	const failed = (cause: unknown) => {
		setNotice(said(cause));
	};

	const background = (task: Promise<unknown>) => {
		task.catch(failed);
	};

	const reachLabel = () =>
		mode() === "chat" ? shownMap()?.reachLabel : undefined;

	const hint = () => {
		const width = size().width - 2 - showsWidth(shows());

		const fits = (hints: ReadonlyArray<string>) =>
			hints.find((h) => Bun.stringWidth(h) <= width) ?? hints.at(-1) ?? "";

		if (paneOpen()) {
			return fits(PANE_HINTS);
		}

		if (mode() === "name") {
			return NAME_HINT;
		}

		if (small()) {
			return fits(tooSmall());
		}

		const lead = reachLabel();
		const free = freeHeroes();

		const told = saidHints(free, lead);
		const hints = myTurn() ? turnHints(told) : told;

		if (lead === undefined) {
			return fits(hints);
		}

		const room = width - Bun.stringWidth(lead) - 3;

		return hints.find((h) => Bun.stringWidth(h) <= room) ?? "";
	};

	const idleHints = () => {
		if (prepOpen()) {
			return prepHints(prepUp(), panelNumber("prep"));
		}

		return unset() ? SETUP_HINTS : keyHints(keys);
	};

	const reachHints = () => {
		if (!reachClipped()) {
			return mapHints(keys);
		}

		const mine = followed(shownMap()?.tokens ?? [])?.mine === true;

		return CLIPPED_HINTS[mine ? "mine" : "theirs"];
	};

	const saidHints = (
		free: ReadonlyArray<string>,
		lead: string | undefined
	): ReadonlyArray<string> => {
		if (free.length > 0) {
			return playHints(free);
		}

		return lead === undefined ? idleHints() : reachHints();
	};

	const shortfall = (): readonly [string, string, string] => {
		const { width: w, height: h } = size();
		const { width: W, height: H } = MIN_SEAT;

		if (w < W && h < H) {
			return [`make your terminal ${W}x${H}`, `${W}x${H}`, `${w}x${h}`];
		}

		return w < W
			? [`widen your terminal to ${W} columns`, `${W} columns`, `${w} wide`]
			: [`make your terminal ${H} rows tall`, `${H} rows`, `${h} tall`];
	};

	const tooSmall = () => {
		const [ask, need, is] = shortfall();

		return [
			`${ask} for the band and the map · it is ${is}`,
			`${ask} · it is ${is}`,
			`${need} needed`,
			"",
		];
	};

	const myTurn = () =>
		view.combat?.()?.combatants.some((c) => c.acting && c.mine) ?? false;

	const freeHeroes = (): ReadonlyArray<string> => {
		const band = view.combat?.()?.combatants ?? [];

		if (view.me === "gm" || band.some((c) => c.mine)) {
			return [];
		}

		return band.flatMap((c) => (c.free === true ? [c.name] : []));
	};

	const unset = () =>
		view.prep !== undefined &&
		view.combat?.() === undefined &&
		view.map?.() === undefined;

	const reachClipped = () => {
		const map = shownMap();

		if (map === undefined || map.reach.length === 0 || panels().mapFirst) {
			return false;
		}

		const rows = mapHeight();
		const mapFirst = viewPreset(panels(), "map");
		const { room, cap } = roomFor(screen(), mapFirst, false);

		const band = bandRows(view.combat?.(), size().width, cap);

		if (mapHeights(mapWanted(map), band, room, mapFirst).map <= rows) {
			return false;
		}

		if (rows === 0) {
			return true;
		}

		if (pictures()) {
			const w = pictureWindow(
				map,
				Math.floor((size().width - MAP_FRAME.width - GUTTER) / SQUARE.cols),
				Math.floor((rows - MAP_FRAME.height - LABEL_ROWS) / SQUARE.rows),
				focus()
			);

			return map.reach.some(
				(r) =>
					r.x < w.x0 ||
					r.x >= w.x0 + w.cols ||
					r.y < w.y0 ||
					r.y >= w.y0 + w.rows
			);
		}

		return mapLayout(
			map,
			size().width - MAP_FRAME.width,
			rows - MAP_FRAME.height,
			focus()
		).reachClipped;
	};

	const small = () =>
		size().width < MIN_SEAT.width || size().height < MIN_SEAT.height;

	const shownMap = (): MapView | undefined => {
		const map = view.map?.();

		return map !== undefined &&
			!campaign() &&
			panels().map &&
			!paneOpen() &&
			!small()
			? map
			: undefined;
	};

	const focus = (): Focus | undefined => {
		const p = pin();

		if (p === undefined) {
			return undefined;
		}

		if ("square" in p) {
			return p.square;
		}

		const t = view.map?.()?.tokens.find((k) => k.id === p.token);

		return t === undefined ? undefined : { x: t.x, y: t.y };
	};

	const acting = createMemo(
		() => view.map?.()?.tokens.find((t) => t.acting && !t.dead)?.id
	);

	createEffect(
		on(
			acting,
			() => {
				setPin(undefined);
			},
			{ defer: true }
		)
	);

	const completer = (text: string) => {
		const host = view.complete(text);

		if (view.map === undefined) {
			return host;
		}

		const own = tableCompletions(text).filter((c) => !host.includes(c));

		return own.length === 0 ? host : [...host, ...own].toSorted();
	};

	const changeLayout = (next: Layout | "toggle") => {
		setPanels(viewPreset(panels(), next));

		if (next !== "toggle") {
			setPin(undefined);
		}

		if (view.map?.() === undefined) {
			setNotice(NO_MAP);
		}
	};

	const toggle = (panel: Panel) => {
		disarm();

		if (panel === "prep") {
			if (view.prep === undefined) {
				setNotice(PREP_IS_GMS);
			} else {
				showPrep();
			}

			return;
		}

		if (panel === "reply" && !multiline()) {
			setNotice(NO_REPLY);

			return;
		}

		if (panel === "map" && view.map?.() === undefined && !campaign()) {
			if (!multiline()) {
				setPanels({ ...panels(), map: !panels().map });
				setNotice(NO_MAP);
			}

			return;
		}

		setPanels(togglePanel(panels(), panel, multiline()));
	};

	const showPrep = (open = false) => {
		const { prep } = view;

		if (prep === undefined) {
			return;
		}

		const shown = !panels().prep || open;
		setPanels({ ...panels(), prep: shown });

		if (!shown) {
			return;
		}

		const reload = async () => {
			const problem = await prep.reload();

			if (problem === undefined) {
				return;
			}

			setNotice(problem);

			if (prep.view() === undefined) {
				setPanels({ ...panels(), prep: false });
			}
		};

		background(reload());
	};

	const chooseLook = (next: Look) => {
		if (next === "pictures" && !picturesShown()) {
			setNotice(
				"This terminal can't show the map in pictures (it needs kitty graphics, as in Ghostty, kitty or WezTerm, and no tmux), so it stays text."
			);

			return;
		}

		setLook(next);

		if (view.map?.() === undefined) {
			setNotice(NO_MAP);
		}
	};

	const centre = (at: string) => {
		const map = view.map?.();

		if (map === undefined) {
			setNotice(NO_MAP);

			return;
		}

		const found = focusOf(map, at);

		if ("refusal" in found) {
			setNotice(found.refusal);

			return;
		}

		setPin(found);

		if (!panels().map) {
			setPanels({ ...panels(), map: true });
		}
	};

	const send = async () => {
		const { state, line: text } = submitLine(line());
		setLine(state);

		if (text === undefined) {
			return;
		}

		const intent = intentFor(text, mode(), view.me, asked());
		hinted = undefined;
		setNotice(undefined);

		if (intent.kind === "quit") {
			view.leave();

			return;
		}

		if (intent.kind === "state") {
			setShowDebug(!showDebug());

			return;
		}

		if (intent.kind === "view") {
			changeLayout(intent.layout);

			return;
		}

		if (intent.kind === "look") {
			chooseLook(intent.look);

			return;
		}

		if (intent.kind === "focus") {
			centre(intent.at);

			return;
		}

		if (intent.kind === "peek") {
			peekAt(intent.at);

			return;
		}

		if (intent.kind === "codex") {
			const stage = view.stage?.();

			const found =
				intent.ref === undefined || stage === undefined
					? undefined
					: codexFind(stage.codex, intent.ref);

			if (
				stage !== undefined &&
				(intent.ref === undefined || found !== undefined)
			) {
				openCodex(found?.key);

				return;
			}

			await deliver(intent.line);

			return;
		}

		if (intent.kind === "hint") {
			setNotice(intent.text);

			if (!intent.again) {
				return;
			}

			hinted = { line: text, hint: intent.text };
			setLine(restoreDraft(line(), text));

			return;
		}

		if (intent.kind === "mouse") {
			switchMouse(intent.on);

			return;
		}

		if (intent.kind === "prep") {
			showPrep(true);

			return;
		}

		await deliver(intent.line);
	};

	const knocking = () => view.knocks?.() ?? [];

	const decideKnock = (knock: KnockShown, verdict: "admit" | "deny") => {
		background(deliver(`/${verdict} ${knock.actor}`));
	};

	const deliver = async (text: string): Promise<string | undefined> => {
		const reply = queue.then(async () => await view.submit(text));
		queue = reply.catch(said);

		try {
			const answer = await reply;

			if (answer?.includes("\n") === true && !panels().reply) {
				setPanels({ ...panels(), reply: true });
			}

			if (answer === undefined || answer === "") {
				return undefined;
			}

			setNotice(answer);

			return answer;
		} catch (error) {
			const message = said(error);
			setNotice(message);

			return message;
		}
	};

	const leave = () => {
		const others = people(view.present()).some((p) => p.actor !== view.me);

		if (view.me !== "gm" || !others || leaving()) {
			view.leave();

			return;
		}

		setNotice(CONFIRM_LEAVE);
	};

	const disarm = () => {
		if (leaving()) {
			setNotice(undefined);
		}
	};

	const escape = () => {
		if (line().completion !== undefined) {
			edit(cancelCompletion);

			return;
		}

		if (selection() !== undefined) {
			setSelection(undefined);

			return;
		}

		if (armed() !== undefined) {
			setArmed(undefined);

			return;
		}

		if (codex() !== undefined) {
			closeCodex();

			return;
		}

		if (notice() !== undefined) {
			setNotice(undefined);

			return;
		}

		if (showDebug()) {
			setShowDebug(false);
		}
	};

	const switchMouse = (wanted: boolean | "toggle") => {
		const next = wanted === "toggle" ? !mouse() : wanted;

		try {
			renderer.useMouse = next;
		} catch (error) {
			setNotice(said(error));

			return;
		}

		setMouse(next);

		if (!next) {
			setSelection(undefined);
		}

		setNotice(next ? MOUSE_ON : MOUSE_OFF);
	};

	const isDead = (id: string) =>
		view.map?.()?.tokens.some((t) => t.id === id && t.dead) === true ||
		view.combat?.()?.combatants.find((c) => c.id === id)?.health === "dead";

	const inPlay = (id: string) =>
		!isDead(id) &&
		(view.map?.()?.tokens.some((t) => t.id === id) === true ||
			view.combat?.()?.combatants.some((c) => c.id === id) === true);

	const mayAct = (id: string) =>
		view.actions?.(id) !== undefined && !isDead(id);

	const clicked = (click: Clicked) => {
		if (!mouse()) {
			return;
		}

		const result = clickOutcome(selection(), click, mayAct);

		if (result.kind === "none") {
			return;
		}

		switch (result.kind) {
			case "select": {
				setSelection({ id: result.id, picked: [] });
				break;
			}

			case "clear": {
				setSelection(undefined);
				break;
			}

			case "picked": {
				const s = selection();

				if (s !== undefined) {
					setSelection({ ...s, picked: result.picked });
				}

				break;
			}

			case "send": {
				background(sendClicked(result.line));
				break;
			}

			case "insert": {
				edit((s) => insertWord(s, result.text));
				break;
			}

			default: {
				break;
			}
		}
	};

	const sendClicked = async (text: string): Promise<string | undefined> => {
		setSelection(undefined);
		setNotice(undefined);
		edit((s) => remember(s, text));

		return await deliver(text);
	};

	const onSquare = (square: Focus) => {
		const map = view.map?.();
		const token = map === undefined ? undefined : tokenAt(map, square);

		if (
			token === undefined &&
			selection() === undefined &&
			placeFromPrep(square)
		) {
			return;
		}

		clicked({
			square: formatSquare(square),
			...ifDefined(token, (value) => ({
				token: { id: value.id, mark: value.mark },
			})),
		});
	};

	const onWho = (id: string) => {
		const c = view.combat?.()?.combatants.find((k) => k.id === id);
		clicked({ token: { id, mark: c?.mark } });
	};

	const pickItem = (item: MenuItem) => {
		disarm();
		const s = selection();

		if (s === undefined || !mouse()) {
			return;
		}

		if (item.kind === "cancel") {
			setSelection(undefined);

			return;
		}

		if (item.kind === "roll") {
			background(sendClicked(item.line));

			return;
		}

		const next = choose(s, item.action);

		if (next.kind === "send") {
			background(sendClicked(next.line));
		} else {
			setSelection(next.selection);
		}
	};

	const after = async (
		text: string,
		then: (answer: string | undefined) => void
	) => {
		then(await sendClicked(text));
	};

	const prepView = () =>
		panels().prep && !small() ? view.prep?.view() : undefined;

	const prepOpen = () => prepView() !== undefined;
	const prepColumns = () => (prepOpen() ? prepWidth(size().width) : 0);

	const campaign = createMemo(() =>
		campaignShown({
			stage: view.stage?.(),
			mapLoaded: view.map?.() !== undefined,
			peek: peek(),
			prepping: prepOpen(),
		})
	);

	createEffect(
		on(
			() => view.stage?.()?.mode,
			() => {
				setPeek(undefined);
			},
			{ defer: true }
		)
	);

	const shownStage = (): StageView | undefined => {
		const stage = view.stage?.();

		return stage !== undefined &&
			campaign() &&
			panels().map &&
			!paneOpen() &&
			!small()
			? stage
			: undefined;
	};

	const stageWidth = () => size().width - prepColumns();

	const planned = createMemo((): StagePlan | undefined => {
		const stage = shownStage();

		return stage === undefined
			? undefined
			: stagePlan(stage, stageWidth(), view.gmNotes);
	});

	const partyShown = (): ReadonlyArray<PartyMember> | undefined => {
		const members = view.party?.() ?? [];

		return campaign() && members.length > 0 && panels().band && !small()
			? members
			: undefined;
	};

	const partyWant = (): BandWant | undefined => {
		const members = partyShown();

		if (members === undefined) {
			return undefined;
		}

		const wanted = partyWanted(members);

		return { wanted, keep: wanted };
	};

	const closeCodex = () => {
		setCodex(undefined);
	};

	const openCodex = (key?: string) => {
		setCodex(key === undefined ? {} : { key });

		if (!campaign()) {
			setPeek("stage");
		}

		if (!panels().map) {
			setPanels({ ...panels(), map: true });
		}
	};

	const peekAt = (at: Slot) => {
		if (at === "stage" && view.stage === undefined) {
			setNotice(NO_STAGE);

			return;
		}

		if (at === "board" && view.map?.() === undefined) {
			setNotice(NO_BOARD);

			return;
		}

		closeCodex();
		setPeek(at);
		setNotice(PEEKS[at]);

		if (!panels().map) {
			setPanels({ ...panels(), map: true });
		}
	};

	const prepUp = createMemo(() => {
		const v = prepView();

		return v === undefined || view.map?.() === undefined
			? undefined
			: prepNext(v, armed());
	});

	createEffect(() => {
		const v = prepView();
		const a = armed();

		if (a !== undefined && (v === undefined || !armedStands(v, a))) {
			setArmed(undefined);
		}
	});
	createEffect(() => {
		const a = adding();
		const map = view.map?.();

		const fresh = (view.prep?.view()?.place ?? []).filter(
			(t) => a !== undefined && t.figure.id === a.figure && !a.before.has(t.id)
		);

		if (a === undefined || map === undefined || fresh.length === 0) {
			return;
		}

		setAdding(undefined);

		for (const placing of placeNear(
			map,
			fresh.map((t) => t.id),
			a.at
		)) {
			background(sendClicked(placing));
		}
	});
	createEffect(() => {
		renderer.setMousePointer(prepUp() === undefined ? "default" : "crosshair");
	});
	onCleanup(() => {
		renderer.setMousePointer("default");
	});

	const placeFromPrep = (square: Focus): boolean => {
		const next = prepUp();
		const v = prepView();

		if (next === undefined || v === undefined || !mouse()) {
			return false;
		}

		setArmed(undefined);

		if (next.kind === "place") {
			background(sendClicked(`/place ${next.id} ${formatSquare(square)}`));

			return true;
		}

		const before = new Set(v.place.map((t) => t.id));

		background(
			after(next.line, (answer) => {
				if (answer === undefined) {
					setAdding({ figure: next.figure.id, at: square, before });
				}
			})
		);

		return true;
	};

	const sendFromPrep = (
		text: string,
		then?: (answer: string | undefined) => void
	) => {
		if (mouse()) {
			background(
				after(text, (answer) => {
					then?.(answer);
				})
			);
		}
	};

	const sendInTurn = async (lines: ReadonlyArray<string>): Promise<void> => {
		const [first, ...rest] = lines;

		if (first === undefined) {
			return;
		}

		const answer = await sendClicked(first);

		if (answer === undefined) {
			await sendInTurn(rest);
		}
	};

	const sendAllFromPrep = (lines: ReadonlyArray<string>) => {
		if (mouse()) {
			background(sendInTurn(lines));
		}
	};

	const startFromPrep = (text: string) => {
		if (!mouse()) {
			return;
		}

		background(
			after(text, (answer) => {
				if (answer === undefined) {
					setPanels({ ...panels(), prep: false });
				}
			})
		);
	};

	const nameOf = (id: string) =>
		view.map?.()?.tokens.find((t) => t.id === id)?.name ??
		view.combat?.()?.combatants.find((c) => c.id === id)?.name ??
		view.prep?.view()?.place.find((t) => t.id === id)?.name ??
		id;

	const markOf = (id: string) =>
		view.map?.()?.tokens.find((t) => t.id === id)?.mark ??
		view.combat?.()?.combatants.find((c) => c.id === id)?.mark ??
		id;

	const menu = createMemo(() => {
		const s = selection();

		const actions =
			s === undefined || !mouse() ? undefined : view.actions?.(s.id);

		return s === undefined || actions === undefined
			? undefined
			: menuOf(s, actions, nameOf, markOf);
	});

	createEffect(() => {
		const s = selection();

		if (s === undefined) {
			return;
		}

		if (small() || !mayAct(s.id) || !menuStands(s, view.actions?.(s.id))) {
			setSelection(undefined);

			return;
		}

		const picked = s.picked.filter(inPlay);

		if (picked.length < s.picked.length) {
			setSelection({ ...s, picked });
		}
	});

	const menuLines = createMemo(() => {
		const m = menu();

		return m === undefined ? [] : menuRows(m, size().width - 2);
	});

	let paneBox: BoxRenderable | undefined;
	let debugBox: BoxRenderable | undefined;

	const scrolled = () => {
		if (paneOpen()) {
			return pane;
		}

		if (showDebug()) {
			return debug;
		}

		if (panels().feed) {
			return feed;
		}

		if (shownStage() !== undefined) {
			return stageBox;
		}

		return prepOpen() ? prepBox : undefined;
	};

	const scroll = (direction: 1 | -1) => {
		scrolled()?.scrollBy(direction * PAGE, "viewport");
	};

	const act = (action: Exclude<KeyAction, { readonly kind: "none" }>) => {
		if (isLineEdit(action)) {
			edit(LINE_EDITS[action.kind]);

			return;
		}

		switch (action.kind) {
			case "insert": {
				edit((s) => insert(s, action.text));
				break;
			}

			case "panel": {
				toggle(action.panel);
				break;
			}

			case "knock": {
				const [oldest] = knocking();

				if (oldest !== undefined) {
					decideKnock(oldest, action.verdict);
				}

				break;
			}

			case "submit": {
				background(send());
				break;
			}

			case "complete": {
				edit((s) => complete(s, completer, action.step));
				break;
			}

			case "scroll": {
				scroll(action.direction);
				break;
			}

			case "escape": {
				escape();
				break;
			}

			case "leave": {
				leave();
				break;
			}

			case "eof": {
				if (line().text === "") {
					leave();
				} else {
					edit(deleteForward);
				}

				break;
			}

			default: {
				break;
			}
		}
	};

	useKeyboard((key: KeyEvent) => {
		const action = keyAction(key);

		if (action.kind !== "leave") {
			disarm();
		}

		if (action.kind === "none") {
			return;
		}

		key.preventDefault();
		act(action);
	});

	usePaste((event: PasteEvent) => {
		event.preventDefault();
		disarm();
		edit((s) => insert(s, decodePasteBytes(event.bytes)));
	});

	const screen = (): Screen => ({
		width: size().width,
		height: size().height,
		knocks: knocking().length > 0,
		menuRows: menuLines().length,
		fighting: view.combat?.()?.active === true,
	});

	const mapWanted = (map: MapView) =>
		pictures() ? pictureRowsWanted(map) : mapRowsWanted(map);

	const paneRows = (text: string): number => {
		const width = Math.max(10, size().width - 4);

		let rows = 0;

		for (const { lead, rest } of hanging(text)) {
			const room = Math.max(1, width - Bun.stringWidth(lead));
			rows += Math.max(1, Math.ceil(Bun.stringWidth(rest) / room));
		}

		return rows;
	};

	const slotWanted = (): number | undefined => {
		const map = shownMap();

		if (map !== undefined) {
			return mapWanted(map);
		}

		const stage = shownStage();
		const plan = planned();

		if (stage === undefined || plan === undefined) {
			return undefined;
		}

		const open = codex();

		return open === undefined
			? stageWanted(plan)
			: codexWanted(stage, open, stageWidth(), view.gmNotes);
	};

	const heights = createMemo(() =>
		layoutHeights({
			screen: screen(),
			shown: panels(),
			combat: view.combat?.(),
			noticeLine: noticeLine(),
			paneOpen: paneOpen(),
			paneRows: paneOpen() ? paneRows(notice() ?? "") : 0,
			small: small(),
			mapWanted: slotWanted(),
			...ifDefined(partyWant(), (party) => ({ party })),
		})
	);

	const nothingShown = () =>
		!small() &&
		!panels().band &&
		mapHeight() === 0 &&
		!panels().feed &&
		!paneOpen() &&
		!prepOpen() &&
		!showDebug();

	const available = () =>
		panelsOf(view.prep !== undefined).filter(
			(p) =>
				(p !== "map" || view.map?.() !== undefined || campaign()) &&
				(p !== "reply" || multiline())
		);

	const shows = () =>
		mouse() && !small() && !nothingShown()
			? hiddenPanels(panels(), available())
			: [];

	const rowFills = () => panels().feed || nothingShown() || showDebug();

	const paneHeight = () => heights().pane;
	const bandHeight = () => heights().band;
	const mapHeight = () => heights().map;

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			onMouseDown={disarm}
			onMouseScroll={disarm}
		>
			<box
				flexDirection="column"
				flexGrow={1}
				flexBasis={0}
				minHeight={0}
				overflow="hidden"
			>
				<Header
					room={view.room}
					me={view.me}
					present={view.present()}
					alert={view.alert?.() ?? problemAlert(view.contentProblems?.() ?? [])}
				/>
				<KnockBanner knocks={knocking()} onDecide={decideKnock} />
				<ErrorBoundary
					fallback={(cause: unknown, reset: () => void) => (
						<Undrawn error={cause} reset={reset} view={view} />
					)}
				>
					<Show when={!small() && panels().band}>
						<Show
							when={partyShown()}
							fallback={
								<Band
									me={view.me}
									present={view.present()}
									joinHint={view.joinHint}
									joinNote={view.joinNote?.()}
									combat={view.combat?.()}
									maxHeight={bandHeight()}
									heroesWhole={paneOpen()}
									mark={panelMark("band")}
									onWho={onWho}
									onTitle={() => {
										toggle("band");
									}}
								/>
							}
						>
							{(members: Accessor<ReadonlyArray<PartyMember>>) => (
								<Party
									members={members()}
									height={bandHeight()}
									mark={panelMark("band")}
									onPick={(id) => {
										if (mouse()) {
											background(sendClicked(sheetLine(id)));
										}
									}}
									onTitle={() => {
										toggle("band");
									}}
								/>
							)}
						</Show>
					</Show>

					<box
						flexDirection="row"
						flexGrow={rowFills() || prepColumns() > 0 ? 1 : 0}
						minHeight={0}
					>
						<box flexDirection="column" flexGrow={1} minWidth={0}>
							<Show when={mapHeight() > 0 ? shownMap() : undefined}>
								{(map: Accessor<MapView>) => (
									<Show
										when={pictures()}
										fallback={
											<MapPane
												map={map()}
												height={mapHeight()}
												width={size().width - prepColumns()}
												focus={focus()}
												hint={picturesShown() ? "/view pictures" : undefined}
												mark={panelMark("map")}
												onSquare={onSquare}
												onTitle={() => {
													toggle("map");
												}}
											/>
										}
									>
										<PictureMap
											map={map()}
											height={mapHeight()}
											width={size().width - prepColumns()}
											focus={focus()}
											mark={panelMark("map")}
											onSquare={onSquare}
											onTitle={() => {
												toggle("map");
											}}
										/>
									</Show>
								)}
							</Show>

							<Show when={mapHeight() > 0 ? shownStage() : undefined}>
								{(stage: Accessor<StageView>) => (
									<Show when={planned()}>
										{(plan: Accessor<StagePlan>) => (
											<Stage
												stage={stage()}
												plan={plan()}
												height={mapHeight()}
												width={stageWidth()}
												notes={view.gmNotes}
												codex={codex()}
												mark={panelMark("map")}
												onCodex={(next) => {
													if (next === undefined) {
														closeCodex();
													} else {
														openCodex(next.key);
													}
												}}
												onTitle={() => {
													toggle("map");
												}}
												ref={(el) => {
													stageBox = el;
												}}
											/>
										)}
									</Show>
								)}
							</Show>

							<box
								flexDirection="row"
								flexGrow={rowFills() ? 1 : 0}
								minHeight={0}
							>
								<Show when={panels().feed}>
									<Feed
										lines={view.feed()}
										ref={(el) => {
											feed = el;
										}}
										mark={panelMark("feed")}
										onTitle={() => {
											toggle("feed");
										}}
									/>
								</Show>
								<Show when={nothingShown()}>
									<box
										flexGrow={1}
										paddingLeft={1}
										paddingRight={1}
										flexDirection="row"
									>
										<For
											each={allHiddenParts(available(), size().width - 2, keys)}
										>
											{(part) => (
												<text
													fg={color.notice}
													wrapMode="none"
													flexShrink={0}
													selectable={false}
													onMouseDown={(event: MouseEvent) => {
														const { panel } = part;

														if (
															panel !== undefined &&
															isLeftButton(event) &&
															mouse()
														) {
															toggle(panel);
														}
													}}
												>
													{part.text}
												</text>
											)}
										</For>
									</box>
								</Show>
								<Show when={showDebug()}>
									<box
										ref={(el: BoxRenderable) => {
											debugBox = el;
										}}
										onMouseDown={boxClick(
											() => debugBox,
											() => " /state · Esc closes ",
											() => {
												setShowDebug(false);
											}
										)}
										border
										borderColor={color.border}
										title=" /state · Esc closes "
										width={panels().feed ? "50%" : "100%"}
										flexShrink={0}
									>
										<scrollbox
											ref={(el: ScrollBoxRenderable) => {
												debug = el;
											}}
											scrollAcceleration={wheel}
											flexGrow={1}
											paddingLeft={1}
										>
											<text fg={color.debug}>{view.debug()}</text>
										</scrollbox>
									</box>
								</Show>
							</box>
						</box>
						<Show when={prepView()}>
							{(v: Accessor<PrepView>) => (
								<Prep
									view={v()}
									next={prepUp()}
									armed={armed()}
									width={prepColumns()}
									mark={panelMark("prep")}
									pictures={picturesShown()}
									onSend={sendFromPrep}
									onFill={(text) => {
										if (mouse()) {
											edit((s) => fillLine(s, text));
										}
									}}
									onAll={sendAllFromPrep}
									stage={view.prep?.stage?.() ?? []}
									sync={view.prep?.sync?.()}
									problems={view.contentProblems?.() ?? []}
									onArm={(a) => {
										if (mouse()) {
											setArmed(a);
										}
									}}
									onCount={(item, by) => {
										if (mouse()) {
											setArmed(prepCount(armed(), item, by));
										}
									}}
									onStart={startFromPrep}
									onTitle={() => {
										toggle("prep");
									}}
									ref={(el) => {
										prepBox = el;
									}}
								/>
							)}
						</Show>
					</box>
				</ErrorBoundary>

				<Show when={notice()}>
					{(text: Accessor<string>) => (
						<Show
							when={paneOpen()}
							fallback={
								<box flexShrink={0} paddingLeft={1} paddingRight={1}>
									<text
										fg={color.notice}
									>{`› ${multiline() ? REPLY_HIDDEN : text()}`}</text>
								</box>
							}
						>
							<box
								ref={(el: BoxRenderable) => {
									paneBox = el;
								}}
								onMouseDown={boxClick(
									() => paneBox,
									() => marked(" just for you ", panelMark("reply")),
									() => {
										toggle("reply");
									}
								)}
								border
								borderColor={color.notice}
								title={marked(" just for you ", panelMark("reply"))}
								height={paneHeight()}
								flexShrink={0}
							>
								<scrollbox
									ref={(el: ScrollBoxRenderable) => {
										pane = el;
									}}
									scrollAcceleration={wheel}
									flexGrow={1}
									paddingLeft={1}
								>
									<For each={hanging(text())}>
										{(row) => (
											<box flexDirection="row" flexShrink={0}>
												<Show when={row.lead !== ""}>
													<text fg={color.text} flexShrink={0} wrapMode="none">
														{row.lead}
													</text>
												</Show>
												<text
													fg={color.text}
													flexGrow={1}
													flexShrink={1}
													minWidth={0}
												>
													{row.rest}
												</text>
											</box>
										)}
									</For>
								</scrollbox>
							</box>
						</Show>
					)}
				</Show>

				<Show when={!rowFills() && prepColumns() === 0}>
					<box flexGrow={1} minHeight={0} />
				</Show>

				<For each={menuLines()}>
					{(row) => (
						<box
							height={1}
							flexShrink={0}
							paddingLeft={1}
							paddingRight={1}
							flexDirection="row"
						>
							<For each={row}>
								{(piece) => {
									const index = piece.item;

									if (index === undefined) {
										return (
											<text fg={color.bright} wrapMode="none" flexShrink={0}>
												{piece.text}
											</text>
										);
									}

									return (
										<text
											wrapMode="none"
											flexShrink={0}
											selectable={false}
											onMouseDown={(event: MouseEvent) => {
												const item = menu()?.items[index];

												if (item !== undefined && isLeftButton(event)) {
													pickItem(item);
												}
											}}
										>
											<span style={{ fg: color.cursorFg, bg: color.cursorBg }}>
												{piece.text}
											</span>
										</text>
									);
								}}
							</For>
						</box>
					)}
				</For>
			</box>

			<HintRow
				hint={hint()}
				completion={line().completion}
				lead={reachLabel()}
				shows={shows()}
				onShow={(panel) => {
					toggle(panel);
				}}
			/>
			<InputLine
				prompt={mode() === "name" ? `${NAME_PROMPT} ` : "> "}
				line={line()}
				width={size().width}
				placeholder={mode() === "chat"}
			/>
		</box>
	);
};
