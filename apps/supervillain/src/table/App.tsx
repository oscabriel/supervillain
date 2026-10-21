import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
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
  type LineState,
  modeFor,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  NAME_PROMPT,
  restoreDraft,
  submitLine,
} from "./input.ts";
import { InputLine } from "./InputLine.tsx";
import { color, people } from "./theme.ts";
import type { TableView } from "./view.ts";

/** Fits 80 columns whole: the hint row never truncates at the smallest supported size. */
const HINT = "Tab completes · ↑↓ history · PgUp/PgDn scroll · /help · Ctrl-C leaves";
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
 * The one chat-first layout, for the GM's terminal and every SSH seat alike. It reads and
 * submits only through the TableView; the input line always owns the keyboard (Q3).
 */
export function App(props: { view: TableView }) {
  const view = props.view;
  const size = useTerminalDimensions();
  const [line, setLine] = createSignal<LineState>(emptyLine);
  const [notice, setNotice] = createSignal<string | undefined>();
  const [showDebug, setShowDebug] = createSignal(false);
  /** The GM pressed Ctrl-C with players here, and the next Ctrl-C closes the table. */
  const [leaving, setLeaving] = createSignal(false);
  let feed: ScrollBoxRenderable | undefined;
  let pane: ScrollBoxRenderable | undefined;
  let debug: ScrollBoxRenderable | undefined;

  const mode = () => modeFor(view.me, view.myName());
  const multiline = () => notice()?.includes("\n") ?? false;
  const edit = (f: (s: LineState) => LineState) => setLine(f(line()));

  const hint = () => (multiline() ? PANE_HINT : mode() === "name" ? NAME_HINT : HINT);

  async function send() {
    const { state, line: text } = submitLine(line());
    setLine(state);
    if (text === undefined) return;
    setNotice(undefined);
    const intent = intentFor(text, mode(), view.me);
    if (intent.kind === "quit") return view.leave();
    if (intent.kind === "state") return void setShowDebug(!showDebug());
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
        return edit((s) => complete(s, view.complete, action.step));
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
   * takes at most half the screen (two thirds in combat, when it's the table's state); a fight's
   * band comes before a reply pane, which scrolls, so a sheet open beside it never hides anyone's
   * numbers. The party or presence band asks little, so there the pane comes first.
   */
  const heights = () => {
    const h = size().height;
    const combat = view.combat?.();
    const room = h - FIXED_ROWS - FEED_MIN - (notice() !== undefined && !multiline() ? 1 : 0);
    const paneWanted = multiline()
      ? Math.max(3, Math.min((notice() ?? "").split("\n").length + 2, Math.floor(h / 2)))
      : 0;
    const cap = Math.floor(combat?.active ? (h * 2) / 3 : h / 2);
    if (combat === undefined || !combat.active) {
      const band = Math.max(BAND_MIN, Math.min(cap, room - paneWanted));
      return { band, pane: paneWanted };
    }
    const layout = bandLayout(combat, size().width - BAND_FRAME.width, cap - BAND_FRAME.height);
    const wanted = layout.lines.length + BAND_FRAME.height;
    const band = Math.max(BAND_MIN, Math.min(wanted, room - (multiline() ? 3 : 0)));
    return { band, pane: multiline() ? Math.max(3, Math.min(paneWanted, room - band)) : 0 };
  };
  const paneHeight = () => heights().pane;
  const bandHeight = () => heights().band;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header room={view.room} me={view.me} present={view.present()} />
      <Band
        me={view.me}
        present={view.present()}
        joinHint={view.joinHint}
        combat={view.combat?.()}
        maxHeight={bandHeight()}
      />

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

      <HintRow hint={hint()} completion={line().completion} />
      <InputLine
        prompt={mode() === "name" ? `${NAME_PROMPT} ` : "> "}
        line={line()}
        width={size().width}
        placeholder={mode() === "chat"}
      />
    </box>
  );
}
