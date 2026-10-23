import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { BAND_FRAME, Band } from "./Band.tsx";
import { bandLayout } from "./band.ts";
import { Feed } from "./Feed.tsx";
import { Header } from "./Header.tsx";
import { HintRow } from "./HintRow.tsx";
import {
  backspace,
  cancelCompletion,
  clearToStart,
  complete,
  deleteForward,
  deleteWordBack,
  emptyLine,
  historyDown,
  historyUp,
  insert,
  intentFor,
  keyAction,
  type Layout,
  type Look,
  type LineState,
  modeFor,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  NAME_PROMPT,
  restoreDraft,
  submitLine,
  tableCompletions,
} from "./input.ts";
import { InputLine } from "./InputLine.tsx";
import { hanging } from "./hanging.ts";
import { type Focus, focusOf, followed, MAP_FRAME, mapLayout, mapRowsWanted } from "./map.ts";
import { MapPane } from "./MapPane.tsx";
import {
  ALL_SHOWN,
  allHiddenLine,
  type Panel,
  PANEL_KEYS,
  PANELS,
  type Panels,
  marked,
  panelMark,
  panelNumber,
  togglePanel,
  viewPreset,
} from "./panels.ts";
import { GUTTER, LABEL_ROWS, pictureRowsWanted, pictureWindow, SQUARE } from "./picture.ts";
import { PictureMap, usePicturesShown } from "./PictureMap.tsx";
import { color, people } from "./theme.ts";
import type { CombatView, MapView, TableView } from "./view.ts";

/** What the panel keys do, said in the hint row where it has room (from about 103 columns). */
const PANEL_HINT = `${PANEL_KEYS} show or hide panels`;
/**
 * The keys, longest first: the first that fits is shown. The last fits 80 columns whole, so the
 * hint row never truncates at the smallest supported size.
 */
const HINTS = [
  `Tab completes · ↑↓ history · PgUp/PgDn scroll · ${PANEL_HINT} · /help · Ctrl-C leaves`,
  "Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves",
];
/**
 * Beside the map's reach label, the keys that matter most, longest first: the first that fits
 * beside the label is shown, and none if none does, so the label is never cut.
 */
const MAP_HINTS = [
  `Tab completes · /view · ${PANEL_HINT} · /help · Ctrl-C leaves`,
  "Tab completes · /view · /help · Ctrl-C leaves",
  "/view · /help",
  "",
];
/**
 * Beside the label, when the map pane can't show the whole reach (a full band at 80x24 leaves it a
 * few rows): where to see it, longest first, for the seat's own hero or someone else.
 */
const CLIPPED_HINTS = {
  mine: ["/view map to see all your reach", "/view map", ""],
  theirs: ["/view map to see all of it", "/view map", ""],
} as const;
const NAME_HINT = "type the name you want, then Enter · Ctrl-C leaves";
const PANE_HINTS = [
  `Esc closes · Alt+${panelNumber("reply")} hides it · PgUp/PgDn scroll it · keep typing as usual`,
  "Esc closes · PgUp/PgDn scroll it · keep typing as usual",
];
/** Said on one line in place of a reply whose pane this seat has hidden. */
const REPLY_HIDDEN = `your reply is hidden · Alt+${panelNumber("reply")} shows it · Esc drops it`;
const CONFIRM_LEAVE = "Players are still here. Ctrl-C again closes the table for everyone.";
/** A page scroll moves this much of the visible height, keeping a little context. */
const PAGE = 0.8;
/** The header, hint and input rows, which never give way. */
const FIXED_ROWS = 3;
/** The feed keeps at least its border and three lines, however full the band and the pane are. */
const FEED_MIN = 5;
/** The band never shrinks below one row inside its border. */
const BAND_MIN = 3;
/**
 * A reply pane beside a fight keeps at least this many rows, or a third of the screen if more,
 * so a sheet reads in a page or two rather than three lines at a time.
 */
const PANE_MIN = 8;
/**
 * The smallest seat. Everything is laid out for it, and the Draw Steel band keeps every hero's
 * whole row at 80 columns. Below it the band would cut heroes' numbers and hide creatures, so
 * instead one line asks for a bigger terminal, and the feed and the input go on working.
 */
const MIN_SEAT = { width: 80, height: 24 } as const;
/** Sharing the screen, the map asks for half the room the band and it share, and at least this. */
const MAP_MIN = 8;
/** Below its border, its letters and two rows of squares, the map isn't drawn at all. */
const MAP_FLOOR = 5;
/** With `/view map` the band folds to two lines inside its border: the map comes first. */
const BAND_FOLDED = 4;
const NO_MAP = "no map is loaded; the layout applies once one is";
const NO_REPLY = "no reply is open; /sheet or /help opens one";

/**
 * The one chat-first layout, for the GM's terminal and every SSH seat alike. It reads and
 * submits only through the TableView; the input line always owns the keyboard (Q3).
 */
export function App(props: { view: TableView }) {
  const view = props.view;
  const size = useTerminalDimensions();
  const [line, setLine] = createSignal<LineState>(emptyLine);
  const [notice, setNotice] = createSignal<string | undefined>();
  const [showDebug, setShowDebug] = createSignal(false);
  /**
   * Which panels this seat shows (Alt+1-4, and `/view` as presets), and whether the map comes
   * first. Never logged, and gone when the seat leaves.
   */
  const [panels, setPanels] = createSignal<Panels>(ALL_SHOWN);
  /**
   * Where this seat's `/view <square|who>` centred the map: a square, or a token it follows. It
   * holds until the turn passes or a layout word (`/view both`) puts the map back to following.
   */
  const [pin, setPin] = createSignal<{ readonly square: Focus } | { readonly token: string }>();
  /** How this seat draws the map (`/view pictures|text`): pictures only where the terminal shows them. */
  const [look, setLook] = createSignal<Look>("text");
  const picturesShown = usePicturesShown();
  const pictures = () => look() === "pictures" && picturesShown();
  /** The GM pressed Ctrl-C with players here, and the next Ctrl-C closes the table. */
  const [leaving, setLeaving] = createSignal(false);
  /** The line a hint just answered: sent again as it is, it goes ahead. */
  let asked: string | undefined;
  /** Lines reach the host one at a time, so one that waits on a file can't be overtaken. */
  let queue: Promise<unknown> = Promise.resolve();
  let feed: ScrollBoxRenderable | undefined;
  let pane: ScrollBoxRenderable | undefined;
  let debug: ScrollBoxRenderable | undefined;

  const mode = () => modeFor(view.me, view.myName());
  /** A reply of several lines (a sheet, /help), which the reply pane shows. */
  const multiline = () => notice()?.includes("\n") ?? false;
  /** The reply pane is on screen: a reply is open and this seat hasn't hidden the pane. */
  const paneOpen = () => multiline() && panels().reply;
  /** The notice takes one line: a one-line reply, or a note that the open reply is hidden. */
  const noticeLine = () => notice() !== undefined && !paneOpen();
  const edit = (f: (s: LineState) => LineState) => setLine(f(line()));

  /** What the map's highlight means, leading the hint row while the map shows. */
  const reachLabel = () => (mode() === "chat" ? shownMap()?.reachLabel : undefined);
  const hint = () => {
    // The row's padding takes two columns.
    const width = size().width - 2;
    const fits = (hints: ReadonlyArray<string>) =>
      hints.find((h) => Bun.stringWidth(h) <= width) ?? hints.at(-1)!;
    if (paneOpen()) return fits(PANE_HINTS);
    if (mode() === "name") return NAME_HINT;
    const lead = reachLabel();
    if (lead === undefined) return fits(HINTS);
    // " · " takes three columns between the label and the keys.
    const room = width - Bun.stringWidth(lead) - 3;
    const hints = reachClipped()
      ? CLIPPED_HINTS[followed(shownMap()?.tokens ?? [])?.mine ? "mine" : "theirs"]
      : MAP_HINTS;
    return hints.find((h) => Bun.stringWidth(h) <= room) ?? "";
  };
  /**
   * Whether the map pane leaves some of the reach out of view, or isn't drawn at all for want of
   * rows, where `/view map` would give it more. On `/view map` there is no more room to give, and
   * with the band hidden `/view map` would bring the band and the feed back and give the map less,
   * so the keys stay.
   */
  const reachClipped = () => {
    const map = shownMap();
    if (map === undefined || map.reach.length === 0 || panels().mapFirst) return false;
    const rows = mapHeight();
    // `/view map` is typed, which drops any notice, so its room has no notice line.
    const mapFirst = viewPreset(panels(), "map");
    const { room, cap } = roomFor(mapFirst, false);
    if (mapHeights(map, view.combat?.(), room, cap, mapFirst).map <= rows) return false;
    if (rows === 0) return true;
    if (pictures()) {
      const w = pictureWindow(
        map,
        Math.floor((size().width - MAP_FRAME.width - GUTTER) / SQUARE.cols),
        Math.floor((rows - MAP_FRAME.height - LABEL_ROWS) / SQUARE.rows),
        focus(),
      );
      return map.reach.some(
        (r) => r.x < w.x0 || r.x >= w.x0 + w.cols || r.y < w.y0 || r.y >= w.y0 + w.rows,
      );
    }
    return mapLayout(map, size().width - MAP_FRAME.width, rows - MAP_FRAME.height, focus())
      .reachClipped;
  };
  const small = () => size().width < MIN_SEAT.width || size().height < MIN_SEAT.height;
  /**
   * The map, while there is one to show: not below the smallest seat, not with its panel hidden
   * (Alt+2, `/view feed`), and not while a reply pane is open (it is for reading now, and Esc or
   * Alt+2 brings the map back).
   */
  const shownMap = (): MapView | undefined => {
    const map = view.map?.();
    return map !== undefined && panels().map && !paneOpen() && !small() ? map : undefined;
  };
  /** Where a pinned view centres: its square, or where its token stands now. */
  const focus = (): Focus | undefined => {
    const p = pin();
    if (p === undefined) return undefined;
    if ("square" in p) return p.square;
    const t = view.map?.()?.tokens.find((k) => k.id === p.token);
    return t === undefined ? undefined : { x: t.x, y: t.y };
  };
  // A new turn puts the map back to following whoever acts.
  createEffect(
    on(
      () => view.map?.()?.tokens.find((t) => t.acting && !t.dead)?.id,
      () => setPin(undefined),
      { defer: true },
    ),
  );

  /** The host's completions and the table's own (`/view`), when this table has maps. */
  const completer = (text: string) => {
    const host = view.complete(text);
    if (view.map === undefined) return host;
    const own = tableCompletions(text).filter((c) => !host.includes(c));
    return own.length === 0 ? host : [...host, ...own].toSorted();
  };

  /**
   * `/view`, a preset over the panels: everything sharing the screen, the map first, the feed
   * without the map; alone it shows or hides the map. A layout word also puts a pinned view back
   * to following.
   */
  function changeLayout(next: Layout | "toggle") {
    setPanels(viewPreset(panels(), next));
    if (next !== "toggle") setPin(undefined);
    if (view.map?.() === undefined) setNotice(NO_MAP);
  }

  /**
   * Shows or hides one panel for this seat, by what it sees now (Alt+1-4). The reply pane without
   * a reply says so. Without a map loaded, the map's choice is kept for when one is and the seat
   * is told, unless a reply is open: that stays as it is, since the notice would replace it.
   */
  function toggle(panel: Panel) {
    if (panel === "reply" && !multiline()) return void setNotice(NO_REPLY);
    if (panel === "map" && view.map?.() === undefined) {
      if (multiline()) return;
      setPanels({ ...panels(), map: !panels().map });
      return void setNotice(NO_MAP);
    }
    setPanels(togglePanel(panels(), panel, multiline()));
  }

  /**
   * `/view pictures` or `/view text`. Pictures need kitty graphics outside a multiplexer; anywhere
   * else they would come out as blocks whose marks can't be read, so the map stays text and says why.
   */
  function chooseLook(next: Look) {
    if (next === "pictures" && !picturesShown())
      return void setNotice(
        "This terminal can't show the map in pictures (it needs kitty graphics, as in Ghostty, kitty or WezTerm, and no tmux), so it stays text.",
      );
    setLook(next);
    if (view.map?.() === undefined) setNotice(NO_MAP);
  }

  /** `/view <square|who>`: centres the map there, showing it if it was hidden. */
  function centre(at: string) {
    const map = view.map?.();
    if (map === undefined) return void setNotice(NO_MAP);
    const found = focusOf(map, at);
    if ("refusal" in found) return void setNotice(found.refusal);
    setPin(found);
    if (!panels().map) setPanels({ ...panels(), map: true });
  }

  async function send() {
    const { state, line: text } = submitLine(line());
    setLine(state);
    if (text === undefined) return;
    setNotice(undefined);
    const intent = intentFor(text, mode(), view.me, asked);
    asked = undefined;
    if (intent.kind === "quit") return view.leave();
    if (intent.kind === "state") return void setShowDebug(!showDebug());
    if (intent.kind === "view") return changeLayout(intent.layout);
    if (intent.kind === "look") return chooseLook(intent.look);
    if (intent.kind === "focus") return centre(intent.at);
    if (intent.kind === "hint") {
      setNotice(intent.text);
      if (!intent.again) return;
      asked = text;
      return setLine(restoreDraft(line(), text));
    }
    // A refused line isn't given back: the next one typed would run into it. Up brings it back.
    const reply = queue.then(() => view.submit(intent.line));
    queue = reply.catch(() => undefined);
    try {
      const text = await reply;
      // A new reply opens the pane again, though the last one was hidden: it was asked for.
      if (text?.includes("\n") && !panels().reply) setPanels({ ...panels(), reply: true });
      if (text !== undefined && text !== "") setNotice(text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  /** Ctrl-C. The GM's seat takes the table down with it, so with players here it asks first. */
  function leave() {
    const others = people(view.present()).some((p) => p.actor !== view.me);
    if (view.me !== "gm" || !others || leaving()) return view.leave();
    setLeaving(true);
    setNotice(CONFIRM_LEAVE);
  }

  function escape() {
    if (line().completion) return edit(cancelCompletion);
    if (notice() !== undefined) return void setNotice(undefined);
    if (showDebug()) setShowDebug(false);
  }

  function scroll(direction: 1 | -1) {
    const target = paneOpen() ? pane : showDebug() ? debug : panels().feed ? feed : undefined;
    target?.scrollBy(direction * PAGE, "viewport");
  }

  useKeyboard((key: KeyEvent) => {
    const action = keyAction(key);
    if (action.kind === "none") return;
    key.preventDefault();
    if (action.kind !== "leave" && leaving()) {
      setLeaving(false);
      if (notice() === CONFIRM_LEAVE) setNotice(undefined);
    }
    switch (action.kind) {
      case "insert":
        return edit((s) => insert(s, action.text));
      case "panel":
        return toggle(action.panel);
      case "submit":
        return void send();
      case "complete":
        return edit((s) => complete(s, completer, action.step));
      case "historyUp":
        return edit(historyUp);
      case "historyDown":
        return edit(historyDown);
      case "scroll":
        return scroll(action.direction);
      case "escape":
        return escape();
      case "leave":
        return leave();
      case "backspace":
        return edit(backspace);
      case "delete":
        return edit(deleteForward);
      case "deleteWord":
        return edit(deleteWordBack);
      case "clearToStart":
        return edit(clearToStart);
      case "eof":
        return line().text === "" ? leave() : edit(deleteForward);
      case "left":
        return edit(moveLeft);
      case "right":
        return edit(moveRight);
      case "home":
        return edit(moveHome);
      case "end":
        return edit(moveEnd);
    }
  });

  usePaste((event: PasteEvent) => {
    event.preventDefault();
    edit((s) => insert(s, decodePasteBytes(event.bytes)));
  });

  /**
   * The band's, the map's and the reply pane's heights, for the panels this seat shows. The input
   * always keeps its rows, and the feed its five while it shows. The band takes at most half the
   * screen (two thirds in combat, when it's the table's state). Beside a fight a reply pane, which
   * scrolls, gets PANE_MIN rows and the band the rest; those rows come from the band's creatures
   * (they pair up, the dead line goes, the rest count as `+N more`) and never from a hero's row or
   * the one acting, so a sheet open beside a fight hides no hero's numbers. The party or presence
   * band asks little, so there the pane comes first. Below the smallest seat the band is one line
   * asking for a bigger terminal.
   *
   * A map shares the rows between the band and the feed (see mapHeights). A hidden panel gives its
   * rows to the others: with the feed hidden the band and the reply pane may take all the room,
   * and with the band hidden the map and the pane have what it took.
   */
  const heights = createMemo(() => {
    const h = size().height;
    const shown = panels();
    const combat = view.combat?.();
    const { room, cap } = roomFor(shown, noticeLine());
    const paneWanted = paneOpen()
      ? Math.max(3, Math.min(paneRows(notice() ?? "") + 2, shown.feed ? Math.floor(h / 2) : room))
      : 0;
    if (small())
      return {
        band: 1,
        pane: paneOpen() ? Math.max(3, Math.min(paneWanted, room - 1)) : 0,
        map: 0,
      };
    const map = shownMap();
    if (map !== undefined) return { ...mapHeights(map, combat, room, cap, shown), pane: 0 };
    if (!shown.band) return { band: 0, pane: paneOpen() ? Math.min(paneWanted, room) : 0, map: 0 };
    if (combat === undefined || !combat.active) {
      const band = Math.max(BAND_MIN, Math.min(cap, room - paneWanted));
      return { band, pane: paneWanted, map: 0 };
    }
    const layout = bandLayout(combat, size().width - BAND_FRAME.width, cap - BAND_FRAME.height, {
      heroesWhole: paneOpen(),
    });
    const wanted = layout.lines.length + BAND_FRAME.height;
    if (!paneOpen()) return { band: Math.max(BAND_MIN, Math.min(wanted, room)), pane: 0, map: 0 };
    const paneMin = Math.min(paneWanted, Math.max(PANE_MIN, Math.floor(h / 3)));
    const keep = Math.min(layout.keepLines + BAND_FRAME.height, room - 3);
    const band = Math.max(BAND_MIN, keep, Math.min(wanted, room - paneMin));
    return { band, pane: Math.max(3, Math.min(paneWanted, room - band)), map: 0 };
  });

  /**
   * The rows the band, the map and the reply pane share with `shown` panels (what the fixed rows,
   * the feed's five and a one-line notice leave), and the most the band takes of them: half the
   * screen, two thirds in combat, or all of it with the feed hidden.
   */
  function roomFor(shown: Panels, notice: boolean) {
    const h = size().height;
    const room = h - FIXED_ROWS - (shown.feed ? FEED_MIN : 0) - (notice ? 1 : 0);
    const cap = shown.feed ? Math.floor(view.combat?.()?.active ? (h * 2) / 3 : h / 2) : room;
    return { room, cap };
  }

  /**
   * The band's and the map's rows when a map shows, out of `room` (what the feed's five rows
   * leave). Sharing (`/view both`), the band keeps a row for every living combatant (each hero on
   * one row, its last details cut with `…`, creatures paired, the dead line gone) and the map gives
   * up its rows for that first, down to none: `/view map` shows it whole. Beyond that the map asks
   * for half the room, at least MAP_MIN, and the band gets the rest up to what it wants; whatever
   * either leaves goes to the other, then to the feed. `/view map` folds the band to two lines
   * (heroes' rows may give up their details, creatures count in `+N more`) and gives the map all it
   * wants beyond that. With the band hidden the map has all it wants of the room.
   */
  function mapHeights(
    map: MapView,
    combat: CombatView | undefined,
    room: number,
    cap: number,
    shown: Panels,
  ) {
    const wanted = pictures() ? pictureRowsWanted(map) : mapRowsWanted(map);
    const drawn = (rows: number) => (rows < MAP_FLOOR ? 0 : rows);
    if (!shown.band) return { band: 0, map: drawn(Math.min(wanted, room)) };
    const band = bandRows(combat, cap);
    if (shown.mapFirst) {
      const folded = Math.min(band.wanted, BAND_FOLDED);
      const mapH = Math.min(wanted, room - folded);
      return { band: Math.max(folded, room - mapH), map: drawn(mapH) };
    }
    const share = Math.min(wanted, Math.max(MAP_MIN, Math.floor(room / 2)));
    const bandH = Math.min(room, Math.max(band.keep, Math.min(band.wanted, room - share)));
    return { band: bandH, map: drawn(Math.min(wanted, room - bandH)) };
  }

  /** The rows the band wants beside a map, and the fewest it keeps: every living combatant's row. */
  function bandRows(combat: CombatView | undefined, cap: number) {
    if (combat === undefined) return { wanted: BAND_MIN, keep: BAND_MIN };
    const layout = bandLayout(combat, size().width - BAND_FRAME.width, cap - BAND_FRAME.height);
    const wanted = Math.max(BAND_MIN, layout.lines.length + BAND_FRAME.height);
    return {
      wanted,
      keep: Math.min(wanted, Math.max(BAND_MIN, layout.livingLines + BAND_FRAME.height)),
    };
  }

  /** The rows a reply takes in the pane, its long lines wrapped under where their text starts. */
  function paneRows(text: string): number {
    // The border, the padding and the scroll bar take four columns.
    const width = Math.max(10, size().width - 4);
    return hanging(text).reduce((rows, { lead, rest }) => {
      const room = Math.max(1, width - Bun.stringWidth(lead));
      return rows + Math.max(1, Math.ceil(Bun.stringWidth(rest) / room));
    }, 0);
  }

  /** No panel is on screen: one line says how to bring them back. */
  const nothingShown = () =>
    !small() &&
    !panels().band &&
    mapHeight() === 0 &&
    !panels().feed &&
    !paneOpen() &&
    !showDebug();
  /** The panels a key would bring back now: the map only once one is loaded, a reply only if open. */
  const available = () =>
    PANELS.filter(
      (p) => (p !== "map" || view.map?.() !== undefined) && (p !== "reply" || multiline()),
    );

  /**
   * The feed's row has something to fill the screen with: the feed, the `/state` pane or the
   * all-hidden line. Without them the reply pane or a notice sits under the panels above, and the
   * rows left over fall below it, above the hint row.
   */
  const rowFills = () => panels().feed || nothingShown() || showDebug();

  const paneHeight = () => heights().pane;
  const bandHeight = () => heights().band;
  const mapHeight = () => heights().map;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header room={view.room} me={view.me} present={view.present()} alert={view.alert?.()} />
      <Show
        when={!small()}
        fallback={
          <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
            <text fg={color.notice} wrapMode="none">
              {`widen your terminal to ${MIN_SEAT.width}x${MIN_SEAT.height} · it is ${size().width}x${size().height}`}
            </text>
          </box>
        }
      >
        <Show when={panels().band}>
          <Band
            me={view.me}
            present={view.present()}
            joinHint={view.joinHint}
            joinNote={view.joinNote?.()}
            combat={view.combat?.()}
            maxHeight={bandHeight()}
            heroesWhole={paneOpen()}
            mark={panelMark("band")}
          />
        </Show>
      </Show>

      <Show when={mapHeight() > 0 ? shownMap() : undefined}>
        {(map) => (
          <Show
            when={pictures()}
            fallback={
              <MapPane
                map={map()}
                height={mapHeight()}
                focus={focus()}
                hint={picturesShown() ? "/view pictures" : undefined}
                mark={panelMark("map")}
              />
            }
          >
            <PictureMap map={map()} height={mapHeight()} focus={focus()} mark={panelMark("map")} />
          </Show>
        )}
      </Show>

      <box flexDirection="row" flexGrow={rowFills() ? 1 : 0} minHeight={0}>
        <Show when={panels().feed}>
          <Feed lines={view.feed()} ref={(el) => (feed = el)} mark={panelMark("feed")} />
        </Show>
        <Show when={nothingShown()}>
          <box flexGrow={1} paddingLeft={1} paddingRight={1}>
            <text fg={color.notice} wrapMode="none">
              {allHiddenLine(available(), size().width - 2)}
            </text>
          </box>
        </Show>
        <Show when={showDebug()}>
          <box
            border
            borderColor={color.border}
            title=" /state · Esc closes "
            width={panels().feed ? "50%" : "100%"}
            flexShrink={0}
          >
            <scrollbox ref={(el: ScrollBoxRenderable) => (debug = el)} flexGrow={1} paddingLeft={1}>
              <text fg={color.debug}>{view.debug()}</text>
            </scrollbox>
          </box>
        </Show>
      </box>

      <Show when={notice()}>
        {(text) => (
          <Show
            when={paneOpen()}
            fallback={
              <box flexShrink={0} paddingLeft={1} paddingRight={1}>
                <text fg={color.notice}>{`› ${multiline() ? REPLY_HIDDEN : text()}`}</text>
              </box>
            }
          >
            <box
              border
              borderColor={color.notice}
              title={marked(" just for you ", panelMark("reply"))}
              height={paneHeight()}
              flexShrink={0}
            >
              <scrollbox
                ref={(el: ScrollBoxRenderable) => (pane = el)}
                flexGrow={1}
                paddingLeft={1}
              >
                <For each={hanging(text())}>
                  {(line) => (
                    <box flexDirection="row" flexShrink={0}>
                      <Show when={line.lead !== ""}>
                        <text fg={color.text} flexShrink={0} wrapMode="none">
                          {line.lead}
                        </text>
                      </Show>
                      <text fg={color.text} flexGrow={1} flexShrink={1} minWidth={0}>
                        {line.rest}
                      </text>
                    </box>
                  )}
                </For>
              </scrollbox>
            </box>
          </Show>
        )}
      </Show>

      <Show when={!rowFills()}>
        <box flexGrow={1} minHeight={0} />
      </Show>

      <HintRow hint={hint()} completion={line().completion} lead={reachLabel()} />
      <InputLine
        prompt={mode() === "name" ? `${NAME_PROMPT} ` : "> "}
        line={line()}
        width={size().width}
        placeholder={mode() === "chat"}
      />
    </box>
  );
}
