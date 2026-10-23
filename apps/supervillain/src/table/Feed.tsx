import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { For } from "solid-js";
import { boxClick, wheel } from "./mouse.ts";
import { marked } from "./panels.ts";
import { color, feedStyle } from "./theme.ts";
import type { FeedLine } from "./view.ts";

/**
 * The shared feed: who and what, styled by kind, newest at the bottom, scrollable. The GM's label
 * is always in the GM's colour, so no player's name can pass for the GM.
 */
export function Feed(props: {
  lines: ReadonlyArray<FeedLine>;
  ref: (el: ScrollBoxRenderable) => void;
  /** The panel's key, leading the title (`³`). */
  mark?: string | undefined;
  /** A click on the title. */
  onTitle?: (() => void) | undefined;
}) {
  let box: BoxRenderable | undefined;
  const title = () => marked(" feed ", props.mark);
  return (
    <box
      ref={(el: BoxRenderable) => (box = el)}
      onMouseDown={boxClick(() => box, title, props.onTitle)}
      border
      borderColor={color.border}
      title={title()}
      flexGrow={1}
      minWidth={0}
    >
      <scrollbox
        ref={props.ref}
        scrollAcceleration={wheel}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        paddingLeft={1}
        paddingRight={1}
      >
        <For each={props.lines}>
          {(l) => {
            const style = feedStyle(l.kind);
            return (
              <text wrapMode="word">
                <span style={{ fg: l.gm ? color.gm : style.who }}>
                  {style.speaker ? l.who : ""}
                </span>
                <span style={{ fg: style.text }}>
                  {style.speaker ? `${style.separator}${l.text}` : l.text}
                </span>
              </text>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}
