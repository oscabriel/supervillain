import { type CliRenderer, CliRenderEvents, NativeImage } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, Index, onCleanup } from "solid-js";
import { columnLabel } from "../game/drawSteel/map.ts";
import { type Focus, MAP_FRAME } from "./map.ts";
import {
  type CellPixels,
  cellPixels,
  GUTTER,
  LABEL_ROWS,
  outOfView,
  paintPicture,
  pictureWindow,
  SQUARE,
  tileFor,
} from "./picture.ts";
import { color } from "./theme.ts";
import type { MapView } from "./view.ts";

/**
 * Whether this seat's terminal shows kitty graphics where the table can use them: not through a
 * multiplexer, which passes images on badly or not at all. Elsewhere pictures would fall back to
 * coloured blocks, where a token's mark can't be read, so the map stays text.
 */
export const showsPictures = (renderer: CliRenderer): boolean =>
  renderer.capabilities?.kitty_graphics === true && renderer.capabilities.multiplexer === "none";

/** `showsPictures`, kept up to date as the terminal answers the renderer's questions. */
export function usePicturesShown(): () => boolean {
  const renderer = useRenderer();
  const [shown, setShown] = createSignal(showsPictures(renderer));
  const update = () => setShown(showsPictures(renderer));
  renderer.on(CliRenderEvents.CAPABILITIES, update);
  onCleanup(() => renderer.off(CliRenderEvents.CAPABILITIES, update));
  return shown;
}

/** Whether `sequence` is a terminal's answer to the window-size question (CSI 14t): ESC [ 4;h;w t. */
const isWindowPixels = (sequence: string) =>
  sequence.startsWith("\x1b[4;") && sequence.endsWith("t");

/**
 * This seat's cell size in pixels, once its terminal has said. The renderer asks for the window's
 * pixel size when it starts and again after every resize (forgetting the old answer meanwhile, so
 * the last known size is kept until the new one comes), and fires no event when the answer lands:
 * this watches its input for the answer and reads the renderer's own reading of it just after.
 * OpenTUI 0.6.6 asks again only when the size in cells changes, so a new cell size on the same
 * grid (a window moved to a screen of another scale) is seen at the next change of cols or rows.
 */
export function useCellPixels(): () => CellPixels | undefined {
  const renderer = useRenderer();
  const read = () =>
    cellPixels(renderer.resolution, renderer.terminalWidth, renderer.terminalHeight);
  const [cell, setCell] = createSignal(read(), {
    equals: (a, b) => a?.width === b?.width && a?.height === b?.height,
  });
  const update = () => {
    const now = read();
    if (now !== undefined) setCell(now);
  };
  const watch = (sequence: string) => {
    if (isWindowPixels(sequence)) queueMicrotask(update);
    return false;
  };
  renderer.prependInputHandler(watch);
  onCleanup(() => renderer.removeInputHandler(watch));
  return cell;
}

/**
 * The picture map (picture.ts), `height` rows border to border: column letters over the squares,
 * row numbers beside them, and the painted squares as one image at the seat's cell size in pixels
 * (`useCellPixels`), which the renderer sends zlib-compressed (a move is tens of KB, a few hundred
 * on a dense map at HiDPI, not megabytes). The view centres as the text map's does; tokens out of
 * view are named in the bottom border.
 */
export function PictureMap(props: { map: MapView; height: number; focus?: Focus | undefined }) {
  const size = useTerminalDimensions();
  const renderer = useRenderer();
  renderer.kittyImageTransport = "zlib";

  const win = createMemo(() =>
    pictureWindow(
      props.map,
      Math.floor((size().width - MAP_FRAME.width - GUTTER) / SQUARE.cols),
      Math.floor((props.height - MAP_FRAME.height - LABEL_ROWS) / SQUARE.rows),
      props.focus,
    ),
  );
  const cell = useCellPixels();
  const tile = createMemo(() => tileFor(cell(), win().cols * win().rows));
  const image = createMemo((previous: NativeImage | undefined) => {
    previous?.dispose();
    const canvas = paintPicture(props.map, win(), tile());
    return NativeImage.fromRgba(canvas.pixels, canvas.width, canvas.height);
  });
  onCleanup(() => image().dispose());

  const columns = createMemo(() => {
    const w = win();
    let line = " ".repeat(GUTTER);
    for (let sx = 0; sx < w.cols; sx++)
      line += ` ${columnLabel(w.x0 + sx).padEnd(SQUARE.cols - 1)}`;
    return line;
  });
  const hidden = createMemo(() => {
    const out = outOfView(props.map, win());
    return out.length === 0 ? "" : ` out of view: ${out.map((t) => t.mark).join(" ")} `;
  });

  return (
    <box
      border
      borderColor={color.border}
      title={` ${props.map.name} · /view text `}
      bottomTitle={hidden()}
      bottomTitleAlignment="right"
      height={props.height}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.dim} wrapMode="none">
        {columns()}
      </text>
      <box flexDirection="row">
        <box width={GUTTER} flexDirection="column">
          <Index each={Array.from({ length: win().rows * SQUARE.rows })}>
            {(_, i) => (
              <text fg={color.dim} wrapMode="none">
                {i % SQUARE.rows === 0 ? String(win().y0 + i / SQUARE.rows + 1).padStart(2) : ""}
              </text>
            )}
          </Index>
        </box>
        <image
          width={win().cols * SQUARE.cols}
          height={win().rows * SQUARE.rows}
          fit="fill"
          protocol="kitty"
          source={image()}
        />
      </box>
    </box>
  );
}
