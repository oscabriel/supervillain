import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createSignal, on, Show } from "solid-js";
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
import { type Focus, focusOf, followed, MAP_FRAME, mapLayout, mapRowsWanted } from "./map.ts";
import { MapPane } from "./MapPane.tsx";
import { color, people } from "./theme.ts";
import type { CombatView, MapView, TableView } from "./view.ts";

/** Fits 80 columns whole: the hint row never truncates at the smallest supported size. */
const HINT = "Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves";
/**
 * Beside the map's reach label, the keys that matter most, longest first: the first that fits
 * beside the label is shown, and none if none does, so the label is never cut.
 */
const MAP_HINTS = ["Tab completes · /view · /help · Ctrl-C leaves", "/view · /help", ""];
/**
 * Beside the label, when the map pane can't show the whole reach (a full band at 80x24 leaves it a
 * few rows): where to see it, longest first, for the seat's own hero or someone else.
 */
const CLIPPED_HINTS = {
  mine: ["/view map to see all your reach", "/view map", ""],
  theirs: ["/view map to see all of it", "/view map", ""],
} as const;
const NAME_HINT = "type the name you want, then Enter · Ctrl-C leaves";
const PANE_HINT = "Esc closes · PgUp/PgDn scroll it · keep typing as usual";
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
  /** How this seat shares the screen with a map (`/view`); without a map it changes nothing. */
  const [split, setSplit] = createSignal<Layout>("both");
  /**
   * Where this seat's `/view <square|who>` centred the map: a square, or a token it follows. It
   * holds until the turn passes or a layout word (`/view both`) puts the map back to following.
   */
  const [pin, setPin] = createSignal<{ readonly square: Focus } | { readonly token: string }>();
  /** The GM pressed Ctrl-C with players here, and the next Ctrl-C closes the table. */
  const [leaving, setLeaving] = createSignal(false);
  let feed: ScrollBoxRenderable | undefined;
  let pane: ScrollBoxRenderable | undefined;
  let debug: ScrollBoxRenderable | undefined;

  const mode = () => modeFor(view.me, view.myName());
  const multiline = () => notice()?.includes("\n") ?? false;
  const edit = (f: (s: LineState) => LineState) => setLine(f(line()));

  /** What the map's highlight means, leading the hint row while the map shows. */
  const reachLabel = () => (mode() === "chat" ? shownMap()?.reachLabel : undefined);
  const hint = () => {
    if (multiline()) return PANE_HINT;
    if (mode() === "name") return NAME_HINT;
    const lead = reachLabel();
    if (lead === undefined) return HINT;
    // The row's padding takes two columns, and " · " three between the label and the keys.
    const room = size().width - 2 - Bun.stringWidth(lead) - 3;
    const hints = reachClipped()
      ? CLIPPED_HINTS[followed(shownMap()?.tokens ?? [])?.mine ? "mine" : "theirs"]
      : MAP_HINTS;
    return hints.find((h) => Bun.stringWidth(h) <= room) ?? "";
  };
  /**
   * Whether the map pane leaves some of the reach out of view, or isn't drawn at all for want of
   * rows. On `/view map` there is no more room to give, so the keys stay.
   */
  const reachClipped = () => {
    const map = shownMap();
    if (map === undefined || map.reach.length === 0 || split() === "map") return false;
    const rows = mapHeight();
    if (rows === 0) return true;
    return mapLayout(map, size().width - MAP_FRAME.width, rows - MAP_FRAME.height, focus())
      .reachClipped;
  };
  const small = () => size().width < MIN_SEAT.width || size().height < MIN_SEAT.height;
  /**
   * The map, while there is one to show: not below the smallest seat, not on `/view feed`, and not
   * while a reply pane is open (it is for reading now, and Esc brings the map back).
   */
  const shownMap = (): MapView | undefined => {
    const map = view.map?.();
    return map !== undefined && split() !== "feed" && !multiline() && !small() ? map : undefined;
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
   * `/view`: the map and the feed both, the map first, the feed alone; alone it shows or hides.
   * A layout word also puts a pinned view back to following.
   */
  function changeLayout(next: Layout | "toggle") {
    if (next === "toggle") setSplit(split() === "feed" ? "both" : "feed");
    else {
      setSplit(next);
      setPin(undefined);
    }
    if (view.map?.() === undefined) setNotice(NO_MAP);
  }

  /** `/view <square|who>`: centres the map there, showing it if it was hidden. */
  function centre(at: string, text: string) {
    const map = view.map?.();
    if (map === undefined) return void setNotice(NO_MAP);
    const found = focusOf(map, at);
    if ("refusal" in found) {
      setNotice(found.refusal);
      return setLine(restoreDraft(line(), text));
    }
    setPin(found);
    if (split() === "feed") setSplit("both");
  }

  async function send() {
    const { state, line: text } = submitLine(line());
    setLine(state);
    if (text === undefined) return;
    setNotice(undefined);
    const intent = intentFor(text, mode(), view.me);
    if (intent.kind === "quit") return view.leave();
    if (intent.kind === "state") return void setShowDebug(!showDebug());
    if (intent.kind === "view") return changeLayout(intent.layout);
    if (intent.kind === "focus") return centre(intent.at, text);
    try {
      const reply = await view.submit(intent.line);
      if (reply === undefined || reply === "") return;
      setNotice(reply);
      // A one-line reply to anything but help is a refusal: give the line back to be fixed.
      // A multi-line reply (a sheet, the help) is something asked for, read in the pane.
      if (!/^\/help\b/i.test(text) && !reply.includes("\n")) setLine(restoreDraft(line(), text));
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
    const target = multiline() ? pane : showDebug() ? debug : feed;
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
   * The band's and the reply pane's heights. The feed and input always keep their rows. The band
   * takes at most half the screen (two thirds in combat, when it's the table's state). Beside a
   * fight a reply pane, which scrolls, gets PANE_MIN rows and the band the rest; those rows come
   * from the band's creatures (they pair up, the dead line goes, the rest count as `+N more`) and
   * never from a hero's row or the one acting, so a sheet open beside a fight hides no hero's
   * numbers. The party or
   * presence band asks little, so there the pane comes first. Below the smallest seat the band is
   * one line asking for a bigger terminal.
   *
   * A map shares the rows between the band and the feed (see mapHeights); the feed keeps its five.
   */
  const heights = () => {
    const h = size().height;
    const combat = view.combat?.();
    const room = h - FIXED_ROWS - FEED_MIN - (notice() !== undefined && !multiline() ? 1 : 0);
    const paneWanted = multiline()
      ? Math.max(3, Math.min((notice() ?? "").split("\n").length + 2, Math.floor(h / 2)))
      : 0;
    if (small())
      return {
        band: 1,
        pane: multiline() ? Math.max(3, Math.min(paneWanted, room - 1)) : 0,
        map: 0,
      };
    const cap = Math.floor(combat?.active ? (h * 2) / 3 : h / 2);
    const map = shownMap();
    if (map !== undefined) return { ...mapHeights(map, combat, room, cap), pane: 0 };
    if (combat === undefined || !combat.active) {
      const band = Math.max(BAND_MIN, Math.min(cap, room - paneWanted));
      return { band, pane: paneWanted, map: 0 };
    }
    const layout = bandLayout(combat, size().width - BAND_FRAME.width, cap - BAND_FRAME.height, {
      heroesWhole: multiline(),
    });
    const wanted = layout.lines.length + BAND_FRAME.height;
    if (!multiline()) return { band: Math.max(BAND_MIN, Math.min(wanted, room)), pane: 0, map: 0 };
    const paneMin = Math.min(paneWanted, Math.max(PANE_MIN, Math.floor(h / 3)));
    const keep = Math.min(layout.keepLines + BAND_FRAME.height, room - 3);
    const band = Math.max(BAND_MIN, keep, Math.min(wanted, room - paneMin));
    return { band, pane: Math.max(3, Math.min(paneWanted, room - band)), map: 0 };
  };

  /**
   * The band's and the map's rows when a map shows, out of `room` (what the feed's five rows
   * leave). The band keeps every hero's row whole and the one acting (creatures fold into `+N
   * more`; they are on the map too). Sharing (`/view both`), the map asks for half the room, at
   * least MAP_MIN, and the band gets the rest up to what it wants; whatever either leaves goes to
   * the other, then to the feed. `/view map` folds the band to two lines (heroes' rows may give up
   * their details, creatures count in `+N more`) and gives the map all it wants beyond that.
   */
  function mapHeights(map: MapView, combat: CombatView | undefined, room: number, cap: number) {
    const wanted = mapRowsWanted(map);
    const band = bandRows(combat, cap);
    if (split() === "map") {
      const folded = Math.min(band.wanted, BAND_FOLDED);
      const mapH = Math.min(wanted, room - folded);
      return { band: Math.max(folded, room - mapH), map: mapH < MAP_FLOOR ? 0 : mapH };
    }
    const share = Math.min(wanted, Math.max(MAP_MIN, Math.floor(room / 2)));
    const bandH = Math.max(band.keep, Math.min(band.wanted, room - share));
    const mapH = Math.min(wanted, room - bandH);
    return { band: bandH, map: mapH < MAP_FLOOR ? 0 : mapH };
  }

  /** The rows the band wants beside a map, and the fewest it keeps: every hero and the one acting. */
  function bandRows(combat: CombatView | undefined, cap: number) {
    if (combat === undefined) return { wanted: BAND_MIN, keep: BAND_MIN };
    const layout = bandLayout(combat, size().width - BAND_FRAME.width, cap - BAND_FRAME.height, {
      heroesWhole: true,
    });
    const wanted = Math.max(BAND_MIN, layout.lines.length + BAND_FRAME.height);
    return {
      wanted,
      keep: Math.min(wanted, Math.max(BAND_MIN, layout.keepLines + BAND_FRAME.height)),
    };
  }

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
        <Band
          me={view.me}
          present={view.present()}
          joinHint={view.joinHint}
          joinNote={view.joinNote?.()}
          combat={view.combat?.()}
          maxHeight={bandHeight()}
          heroesWhole={multiline() || (shownMap() !== undefined && split() !== "map")}
        />
      </Show>

      <Show when={mapHeight() > 0 ? shownMap() : undefined}>
        {(map) => <MapPane map={map()} height={mapHeight()} focus={focus()} />}
      </Show>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Feed lines={view.feed()} ref={(el) => (feed = el)} />
        <Show when={showDebug()}>
          <box
            border
            borderColor={color.border}
            title=" /state · Esc closes "
            width="50%"
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
            when={multiline()}
            fallback={
              <box flexShrink={0} paddingLeft={1} paddingRight={1}>
                <text fg={color.notice}>{`› ${text()}`}</text>
              </box>
            }
          >
            <box
              border
              borderColor={color.notice}
              title=" just for you "
              height={paneHeight()}
              flexShrink={0}
            >
              <scrollbox
                ref={(el: ScrollBoxRenderable) => (pane = el)}
                flexGrow={1}
                paddingLeft={1}
              >
                <text fg={color.text}>{text()}</text>
              </scrollbox>
            </box>
          </Show>
        )}
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
