import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For } from "solid-js";
import { keepLines } from "./keep.ts";
import { type Focus, MAP_FRAME, mapLayout, type MapSegment, type MapTone } from "./map.ts";
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
export function MapPane(props: { map: MapView; height: number; focus?: Focus | undefined }) {
  const size = useTerminalDimensions();
  const keep = keepLines<MapSegment>();
  const layout = createMemo(() => {
    const laid = mapLayout(
      props.map,
      size().width - MAP_FRAME.width,
      props.height - MAP_FRAME.height,
      props.focus,
    );
    return { ...laid, lines: keep(laid.lines) };
  });
  return (
    <box
      border
      borderColor={color.border}
      title={layout().title}
      bottomTitle={layout().bottomTitle}
      bottomTitleAlignment="right"
      height={props.height}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={layout().lines}>
        {(line) => (
          <text wrapMode="none">
            <For each={line}>{(s) => <span style={styleOf(s)}>{s.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  );
}
