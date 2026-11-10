import { MouseButton } from "@opentui/core";
import { For, Show } from "solid-js";
import type { Completion } from "./input.ts";
import { type Panel, shownAgainText } from "./panels.ts";
import { color } from "./theme.ts";

/** What leads the hidden panels at the hint row's end. */
export const SHOWS_LEAD = " · show";

/** The columns the hidden panels take at the hint row's end: the lead, then ` ² map` for each. */
export const showsWidth = (shows: ReadonlyArray<Panel>): number =>
  shows.length === 0
    ? 0
    : Bun.stringWidth(SHOWS_LEAD) +
      shows.reduce((n, p) => n + 1 + Bun.stringWidth(shownAgainText(p)), 0);

/**
 * One dim row under the feed: what the keys do now, or the Tab candidates with the current one lit.
 * A `lead` (what the map's highlight means) goes first, on the reach tint, so it is the legend too.
 * The panels this seat has hidden end the row (`· show ¹ band ³ feed`), each shown again by a
 * click, while the mouse is on. On a seat one row tall it gives that row to the input line.
 */
export function HintRow(props: {
  hint: string;
  completion: Completion | undefined;
  lead?: string | undefined;
  shows?: ReadonlyArray<Panel> | undefined;
  onShow?: ((panel: Panel) => void) | undefined;
}) {
  const shows = () => (props.completion === undefined ? (props.shows ?? []) : []);
  return (
    <box height={1} flexShrink={1} paddingLeft={1} paddingRight={1} flexDirection="row">
      <text wrapMode="none" truncate flexShrink={1} minWidth={0}>
        <Show
          when={props.completion}
          fallback={
            <>
              <Show when={props.lead}>
                {(lead) => (
                  <>
                    <span style={{ fg: color.text, bg: color.reach }}>{lead()}</span>
                    <Show when={props.hint !== ""}>
                      <span style={{ fg: color.dim }}>{" · "}</span>
                    </Show>
                  </>
                )}
              </Show>
              <span style={{ fg: color.dim }}>{props.hint}</span>
            </>
          }
        >
          {(c) => (
            <>
              <span style={{ fg: color.dim }}>Tab:</span>
              <For each={c().candidates}>
                {(candidate, i) => (
                  <>
                    <span>{"  "}</span>
                    <span
                      style={
                        i() === c().index
                          ? { fg: color.cursorFg, bg: color.cursorBg }
                          : { fg: color.dim }
                      }
                    >
                      {candidate.trim()}
                    </span>
                  </>
                )}
              </For>
            </>
          )}
        </Show>
      </text>
      <Show when={shows().length > 0}>
        <text wrapMode="none" flexShrink={0} fg={color.dim}>
          {SHOWS_LEAD}
        </text>
        <For each={shows()}>
          {(panel) => (
            <text
              wrapMode="none"
              flexShrink={0}
              selectable={false}
              onMouseDown={(event) => {
                if (event.button === MouseButton.LEFT) props.onShow?.(panel);
              }}
            >
              <span> </span>
              <span style={{ fg: color.text, bg: color.mineBg }}>{shownAgainText(panel)}</span>
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}
