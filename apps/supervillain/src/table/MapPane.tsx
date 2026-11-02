import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For } from "solid-js";
import { keepLines } from "./keep.ts";
import { fittedTitle } from "./panels.ts";
import {
  type Focus,
  MAP_FRAME,
  mapLayout,
  type MapSegment,
  type MapTone,
  squareAt,
} from "./map.ts";
import { boxClick } from "./mouse.ts";
import { color } from "./theme.ts";
import type { MapView } from "./view.ts";

const TONES: Readonly<Record<MapTone, string>> = {
  label: color.dim,
  floor: color.floor,
  wall: color.wall,
  difficult: color.difficult,
  terrain: color.terrain,
  heroes: color.heroes,
  director: color.director,
  mine: color.you,
  dead: color.dim,
};

const TOKENS: ReadonlySet<MapTone> = new Set(["heroes", "director", "mine"]);

const styleOf = (s: MapSegment) => ({
  fg: TONES[s.tone],
  ...(s.reach ? { bg: color.reach } : {}),
  bold: TOKENS.has(s.tone),
  underline: s.acting ?? false,
});

/**
 * The text map (ASSESSMENT Q7), `height` rows border to border, the screen's width. Squares are two
 * columns wide under column letters and beside row numbers, centred when the map fits; when it
 * doesn't, the view centres on `focus` (the seat's `/view <square|who>`) or follows the acting
 * token or the seat's own hero, else shows the most tokens it can, with arrows at the edges toward
 * the tokens out of view, named in the bottom border.
 */
export function MapPane(props: {
  map: MapView;
  height: number;
  /** Its columns, the screen's width unless the prep panel takes some. */
  width?: number | undefined;
  focus?: Focus | undefined;
  /**
   * Said after the title, e.g. `/view pictures` where this seat could draw the map in pictures.
   * Where the title can't hold it all, the hint goes first, then the rows and columns shown.
   */
  hint?: string | undefined;
  /** The panel's key, leading the title (`²`). */
  mark?: string | undefined;
  /** A click on a square. */
  onSquare?: ((square: Focus) => void) | undefined;
  /** A click on the title. */
  onTitle?: (() => void) | undefined;
}) {
  const terminal = useTerminalDimensions();
  const size = () => ({ width: props.width ?? terminal().width });
  const keep = keepLines<MapSegment>();
  let box: BoxRenderable | undefined;
  const layout = createMemo(() => {
    const laid = mapLayout(
      props.map,
      size().width - MAP_FRAME.width,
      props.height - MAP_FRAME.height,
      props.focus,
    );
    return { ...laid, lines: keep(laid.lines) };
  });
  const title = () =>
    fittedTitle(
      [
        ...(props.hint ? [`${layout().title.trimEnd()} · ${props.hint} `] : []),
        layout().title,
        ` map · ${props.map.name} `,
      ],
      props.mark,
      size().width,
    );
  /** A left click: on the title, or on a square, counted inside the frame as the lines are. */
  const click = boxClick(
    () => box,
    title,
    props.onTitle,
    (col, row) => {
      const at = squareAt(layout().squares, col - MAP_FRAME.width / 2, row - MAP_FRAME.height / 2);
      if (at !== undefined) props.onSquare?.(at);
    },
  );
  return (
    <box
      ref={(el: BoxRenderable) => (box = el)}
      onMouseDown={click}
      border
      borderColor={color.border}
      title={title()}
      bottomTitle={layout().bottomTitle}
      bottomTitleAlignment="right"
      height={props.height}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={layout().lines}>
        {(line) => (
          <text wrapMode="none" selectable={false}>
            <For each={line}>{(s) => <span style={styleOf(s)}>{s.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  );
}
