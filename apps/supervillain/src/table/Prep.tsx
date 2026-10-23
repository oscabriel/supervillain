import {
  type BoxRenderable,
  MouseButton,
  type MouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { For } from "solid-js";
import { boxClick, wheel } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import type { PrepAction, PrepPiece } from "./prep.ts";
import { color } from "./theme.ts";

/** The titles the prep panel's border takes, longest first: the first that fits is drawn. */
const TITLES = [" prep · click to send · the dim words are how to type it ", " prep "];

/** An item's label and a count's buttons: the label lit, the rest of the piece dim. */
const LABEL: Readonly<Record<PrepPiece["tone"], { fg: string; bg?: string }>> = {
  title: { fg: color.gm },
  item: { fg: color.bright, bg: color.mineBg },
  active: { fg: color.cursorFg, bg: color.cursorBg },
  button: { fg: color.cursorFg, bg: color.cursorBg },
  note: { fg: color.dim },
  plain: { fg: color.text },
};

/**
 * The GM's prep panel (Alt+5, `/prep`): its rows, laid out by `prepRows`, scrolling when they are
 * more than its height. Each item or button is its own text, so a click lands on it and never
 * selects it.
 */
export function Prep(props: {
  rows: ReadonlyArray<ReadonlyArray<PrepPiece>>;
  height: number;
  width: number;
  /** The panel's key, leading the title (`⁵`). */
  mark: string;
  onPick: (action: PrepAction) => void;
  onTitle: () => void;
  ref?: (el: ScrollBoxRenderable) => void;
}) {
  let box: BoxRenderable | undefined;
  const title = () => fittedTitle(TITLES, props.mark, props.width);
  return (
    <box
      ref={(el: BoxRenderable) => (box = el)}
      onMouseDown={boxClick(() => box, title, props.onTitle)}
      border
      borderColor={color.gm}
      title={title()}
      height={props.height}
      flexShrink={0}
    >
      <scrollbox ref={props.ref} scrollAcceleration={wheel} flexGrow={1} paddingLeft={1}>
        <For each={props.rows}>
          {(row) => (
            <box height={1} flexShrink={0} flexDirection="row">
              <For each={row}>
                {(piece) => {
                  const look = LABEL[piece.tone];
                  const action = piece.action;
                  return (
                    <text
                      wrapMode="none"
                      flexShrink={0}
                      selectable={action === undefined}
                      onMouseDown={(event: MouseEvent) => {
                        if (action !== undefined && event.button === MouseButton.LEFT)
                          props.onPick(action);
                      }}
                    >
                      <span style={look.bg === undefined ? { fg: look.fg } : look}>
                        {piece.text}
                      </span>
                      <span style={{ fg: color.dim }}>
                        {piece.command === undefined ? "" : ` ${piece.command}`}
                      </span>
                      <span style={{ fg: color.you }}>
                        {piece.note === undefined ? "" : ` · ${piece.note}`}
                      </span>
                    </text>
                  );
                }}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  );
}
