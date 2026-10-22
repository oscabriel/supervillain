// PROTOTYPE, throwaway (branch prototype/map-art). The battlemap drawn with images, in three
// variants beside the text map. F2 cycles the variant and F3 the image protocol, per seat; the
// title says how many bytes the last change of the map cost this seat. See README.md.
import { NativeImage, type ImageRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createComputed, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { columnLabel } from "../../game/drawSteel/map.ts";
import { MAP_FRAME } from "../map.ts";
import { color } from "../theme.ts";
import type { MapToken, MapView } from "../view.ts";
import { type Canvas, paintMinis, paintPainted, paintSprite, type Window } from "./paint.ts";

export type Variant = "text" | "painted" | "minis" | "sprites";
export const VARIANTS: ReadonlyArray<Variant> = ["text", "painted", "minis", "sprites"];
const NAMES: Record<Variant, string> = {
  text: "text (today)",
  painted: "A painted",
  minis: "B miniatures",
  sprites: "C text + sprites",
};
export type Protocol = "auto" | "kitty" | "sixel" | "blocks";
export const PROTOCOLS: ReadonlyArray<Protocol> = ["auto", "kitty", "sixel", "blocks"];

export const variantName = (v: Variant) => NAMES[v];

/** A square is 4 columns by 2 rows, so it's about square and big enough for a picture. */
const SQ_W = 4;
const SQ_H = 2;
/** The row-number gutter and the column-letter row. */
const GUTTER = 3;
const LABEL_ROWS = 1;

/** The rows an art map wants to show `map` whole, border to border. */
export const artRowsWanted = (map: MapView) => map.height * SQ_H + LABEL_ROWS + MAP_FRAME.height;

/** The bytes each SSH seat's channel has carried, set by packages/ssh (PROTOTYPE hack). */
const wire = (renderer: object): { bytes: number } | undefined =>
  (globalThis as { __svWire?: WeakMap<object, { bytes: number }> }).__svWire?.get(renderer);

const toImage = (c: Canvas) => NativeImage.fromRgba(c.pixels, c.width, c.height);

/** Which squares fit, centred on the acting token, else the seat's hero, else the middle. */
const windowOf = (map: MapView, cols: number, rows: number): Window => {
  const fitC = Math.max(1, Math.min(map.width, cols));
  const fitR = Math.max(1, Math.min(map.height, rows));
  const focus = map.tokens.find((t) => t.acting) ??
    map.tokens.find((t) => t.mine) ?? { x: map.width / 2, y: map.height / 2 };
  const clamp = (v: number, span: number, total: number) =>
    Math.max(0, Math.min(total - span, Math.round(v - span / 2)));
  return {
    x0: clamp(focus.x, fitC, map.width),
    y0: clamp(focus.y, fitR, map.height),
    cols: fitC,
    rows: fitR,
  };
};

const TEXT_TERRAIN: Record<string, { rows: [string, string]; fg: string }> = {
  ".": { rows: [" ·  ", "    "], fg: color.floor },
  "#": { rows: ["████", "████"], fg: color.wall },
  "~": { rows: ["~ ~ ", " ~ ~"], fg: color.difficult },
  " ": { rows: ["    ", "    "], fg: color.floor },
};

export function ArtMap(props: {
  map: MapView;
  height: number;
  variant: Exclude<Variant, "text">;
  protocol: Protocol;
  /** How kitty images travel: zlib-compressed or raw pixels (F4). */
  transport: "zlib" | "raw";
}) {
  const size = useTerminalDimensions();
  const renderer = useRenderer();
  const win = createMemo(() =>
    windowOf(
      props.map,
      Math.floor((size().width - MAP_FRAME.width - GUTTER) / SQ_W),
      Math.floor((props.height - MAP_FRAME.height - LABEL_ROWS) / SQ_H),
    ),
  );

  // ---- What a change costs on the wire: the bytes this seat was sent since the map last changed
  // (a move, a new turn, F2 or F3). Chat and the band count too, so read it right after a change.
  const [cost, setCost] = createSignal("");
  const [effective, setEffective] = createSignal("");
  let image: ImageRenderable | undefined;
  let mark = 0;
  createComputed(() => {
    renderer.kittyImageTransport = props.transport;
  });
  createComputed(() => {
    void props.transport;
    void props.map;
    void props.variant;
    void props.protocol;
    mark = wire(renderer)?.bytes ?? 0;
  });
  const poll = setInterval(() => {
    const now = wire(renderer)?.bytes;
    setCost(now === undefined ? "bytes: local, not counted" : `since the change ${kb(now - mark)}`);
    if (image) setEffective(image.effectiveProtocol);
  }, 250);
  onCleanup(() => clearInterval(poll));

  // ---- Variants A and B: the whole view as one image.
  const whole = createMemo((previous: NativeImage | undefined) => {
    previous?.dispose();
    if (props.variant === "sprites") return undefined;
    const paint = props.variant === "painted" ? paintPainted : paintMinis;
    return toImage(paint(props.map, win()));
  });

  // ---- Variant C: text terrain, a sprite per token, each sprite painted once and kept.
  const sprites = new Map<string, NativeImage>();
  onCleanup(() => sprites.forEach((s) => s.dispose()));
  const spriteOf = (t: MapToken, reach: boolean) => {
    const key = `${t.id}|${t.mark}|${t.side}|${t.mine}|${t.acting}|${t.dead}|${reach}`;
    let s = sprites.get(key);
    if (!s) sprites.set(key, (s = toImage(paintSprite(t, reach))));
    return s;
  };
  const reachKeys = createMemo(() => new Set(props.map.reach.map((r) => `${r.x},${r.y}`)));
  const textRows = createMemo(() => {
    const w = win();
    const rows: { text: string; fg: string; bg?: string }[][] = [];
    for (let sy = 0; sy < w.rows; sy++)
      for (let half = 0; half < SQ_H; half++) {
        const line: { text: string; fg: string; bg?: string }[] = [];
        for (let sx = 0; sx < w.cols; sx++) {
          const x = w.x0 + sx;
          const y = w.y0 + sy;
          const t = TEXT_TERRAIN[props.map.terrain[y]?.[x] ?? " "] ?? TEXT_TERRAIN[" "]!;
          line.push({
            text: t.rows[half as 0 | 1],
            fg: t.fg,
            ...(reachKeys().has(`${x},${y}`) ? { bg: color.reach } : {}),
          });
        }
        rows.push(line);
      }
    return rows;
  });
  const visibleTokens = createMemo(() => {
    const w = win();
    return props.map.tokens
      .filter((t) => t.x >= w.x0 && t.x < w.x0 + w.cols && t.y >= w.y0 && t.y < w.y0 + w.rows)
      .toSorted((a, b) => Number(b.dead) - Number(a.dead));
  });

  const columns = createMemo(() => {
    const w = win();
    let s = " ".repeat(GUTTER);
    for (let sx = 0; sx < w.cols; sx++) s += ` ${columnLabel(w.x0 + sx).padEnd(SQ_W - 1)}`;
    return s;
  });

  const title = () =>
    ` ${props.map.name} · PROTOTYPE ${variantName(props.variant)} (F2) · ${props.protocol}${
      effective() ? ` → ${effective()}` : ""
    } (F3) · ${props.transport} (F4) · ${cost()} `;

  return (
    <box
      border
      borderColor={color.border}
      title={title()}
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
          <Index each={Array.from({ length: win().rows * SQ_H })}>
            {(_, i) => (
              <text fg={color.dim} wrapMode="none">
                {i % SQ_H === 0 ? String(win().y0 + i / SQ_H + 1).padStart(2) : ""}
              </text>
            )}
          </Index>
        </box>
        <Show
          when={props.variant !== "sprites" && whole()}
          fallback={
            <box width={win().cols * SQ_W} height={win().rows * SQ_H} flexDirection="column">
              <For each={textRows()}>
                {(line) => (
                  <text wrapMode="none">
                    <For each={line}>
                      {(s) => (
                        <span style={{ fg: s.fg, ...(s.bg ? { bg: s.bg } : {}) }}>{s.text}</span>
                      )}
                    </For>
                  </text>
                )}
              </For>
              <For each={visibleTokens()}>
                {(t) => (
                  <image
                    ref={(el: ImageRenderable) => (image = el)}
                    position="absolute"
                    left={(t.x - win().x0) * SQ_W}
                    top={(t.y - win().y0) * SQ_H}
                    width={SQ_W}
                    height={SQ_H}
                    fit="fill"
                    protocol={props.protocol}
                    source={spriteOf(
                      t,
                      props.variant === "sprites" && reachKeys().has(`${t.x},${t.y}`),
                    )}
                  />
                )}
              </For>
            </box>
          }
        >
          {(img) => (
            <image
              ref={(el: ImageRenderable) => (image = el)}
              width={win().cols * SQ_W}
              height={win().rows * SQ_H}
              fit="fill"
              protocol={props.protocol}
              source={img()}
            />
          )}
        </Show>
      </box>
    </box>
  );
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
