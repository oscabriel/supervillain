import {
  type BoxRenderable,
  MouseButton,
  type MouseEvent,
  NativeImage,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { DINGS_ATLAS } from "./atlas/dings.ts";
import { boxClick, wheel } from "./mouse.ts";
import { fittedTitle } from "./panels.ts";
import { Canvas, figureOf, SIDES, tileFor } from "./picture.ts";
import { useCellPixels } from "./PictureMap.tsx";
import { figureText, type PrepArmed, type PrepNext } from "./prep.ts";
import { color } from "./theme.ts";
import type { PrepFigure, PrepView } from "./view.ts";

/** The titles the panel's border takes, longest first: the first that fits is drawn. */
const TITLES = [" GM prep ", " prep "];
/** What is about to go on the map, and the border while it waits for its square. */
const NEXT = color.brand;
const READY = color.healthy;
/** A big play triangle, for Fight. */
const PLAY = ["█▄  ", "███▄", "███▀", "█▀  "];
/** The rows under the steps for what is next, as tall as its picture and as Fight. */
const SLOT_ROWS = 4;

/** A left click runs `fn`, and goes no further than this piece: a chip's row never sees it. */
const left = (fn: () => void) => (event: MouseEvent) => {
  if (event.button !== MouseButton.LEFT) return;
  event.stopPropagation();
  fn();
};
/** `s` in `n` columns, cut with `…`. */
const fit = (s: string, n: number) =>
  Bun.stringWidth(s) <= n ? s : `${[...s].slice(0, Math.max(0, n - 1)).join("")}…`;
/**
 * A name in `n` columns, cut in the middle where it ends in a short word, so the number or letter
 * that tells two of a kind apart stays: `Goblin Warr… 2`.
 */
export const fitName = (s: string, n: number) => {
  const end = / (\S{1,3})$/.exec(s)?.[1];
  if (Bun.stringWidth(s) <= n || end === undefined) return fit(s, n);
  return `${fit(s.slice(0, -end.length - 1), n - end.length - 1)} ${end}`;
};

/**
 * The GM's prep panel (Alt+5, `/prep`), a column right of the map: the steps to a fight, what the
 * next square clicked on the map does, and under it, scrolling, the map, who waits for a square
 * and what can come in, each drawn as its token is. Whatever goes on the map or into play leaves
 * the list, and once all are placed Fight starts it. A click sends the line typing would, through
 * the App, which fills in the square.
 */
export function Prep(props: {
  view: PrepView;
  next: PrepNext | undefined;
  armed: PrepArmed | undefined;
  width: number;
  /** The panel's key, leading the title (`⁵`). */
  mark: string;
  /** The terminal shows kitty pictures: tokens are drawn as the picture map draws them. */
  pictures: boolean;
  /** Sends a line, resolving to the reply when it was refused (or answered), else undefined. */
  onSend: (line: string) => Promise<string | undefined>;
  onFill: (line: string) => void;
  /** Sends each line, one after another. */
  onAll: (lines: ReadonlyArray<string>) => void;
  onArm: (armed: PrepArmed | undefined) => void;
  onCount: (section: number, index: number, by: 1 | -1) => void;
  onStart: (line: string) => void;
  onTitle: () => void;
  ref?: (el: ScrollBoxRenderable) => void;
}) {
  let box: BoxRenderable | undefined;
  const title = () => fittedTitle(TITLES, props.mark, props.width);
  /** The columns inside the border and the padding, less one for the list's scroll bar. */
  const inner = () => props.width - 5;
  /** The maps list, opened again from the loaded map's ⇄. */
  const [mapsOpen, setMapsOpen] = createSignal(false);
  const cell = useCellPixels();
  const images = new Map<string, NativeImage>();
  onCleanup(() => {
    for (const image of images.values()) image.dispose();
  });

  /** A token `squares` map squares a side, its figure on its side's tint, as the map paints it. */
  const image = (figure: PrepFigure, squares: number) => {
    const t = tileFor(cell());
    const key = `${figure.side}:${figure.id}:${squares}:${t.width}x${t.height}`;
    const had = images.get(key);
    if (had !== undefined) return had;
    const w = t.width * squares;
    const h = t.height * squares;
    const scale = Math.max(1, Math.floor(Math.min(w / 8, h / 12)));
    const tone = SIDES[figure.side];
    const c = new Canvas(w, h);
    c.rect(0, 0, w, h, [
      Math.round(14 + (tone[0] - 14) * 0.18),
      Math.round(15 + (tone[1] - 15) * 0.18),
      Math.round(18 + (tone[2] - 18) * 0.18),
    ]);
    const glyph = DINGS_ATLAS[figureOf(figure)];
    c.glyph(glyph, Math.floor((w - 8 * scale) / 2), Math.floor((h - 12 * scale) / 2), scale, tone);
    const made = NativeImage.fromRgba(c.pixels, c.width, c.height);
    images.set(key, made);
    return made;
  };
  /** How many a square adds, said beside the next: `+3`. */
  const added = (next: PrepNext) => (next.kind === "add" ? `+${next.n}  ` : "");
  const sideColour = (figure: PrepFigure) =>
    figure.side === "heroes" ? color.heroes : color.director;

  /** A token, two rows tall: a picture of it, or its figure in blocks. */
  const token = (figure: PrepFigure): JSX.Element =>
    props.pictures ? (
      <image width={4} height={2} fit="fill" protocol="kitty" source={image(figure, 1)} />
    ) : (
      <text fg={sideColour(figure)} wrapMode="none" flexShrink={0} selectable={false}>
        {figureText(DINGS_ATLAS[figureOf(figure)]).join("\n")}
      </text>
    );

  const bar = (on: boolean, rows: number) => (
    <text fg={NEXT} wrapMode="none" flexShrink={0} selectable={false}>
      {Array.from({ length: rows }, () => (on ? "▌" : " ")).join("\n")}
    </text>
  );

  /** One row of the list: a token, its name, and a note under it; `extra` sits at its end. */
  const entry = (o: {
    figure: PrepFigure;
    name: string;
    note?: () => JSX.Element;
    marked?: () => boolean;
    dim?: boolean;
    onClick: () => void;
    extra?: () => JSX.Element;
  }) => (
    <box flexDirection="row" height={2} flexShrink={0} onMouseDown={left(o.onClick)}>
      {bar(o.marked?.() ?? false, 2)}
      {token(o.figure)}
      <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
        <text
          wrapMode="none"
          selectable={false}
          fg={o.marked?.() ? color.bright : o.dim ? color.dim : color.text}
        >
          {fitName(o.name, inner() - 6 - (o.extra === undefined ? 0 : 3))}
        </text>
        <text wrapMode="none" selectable={false}>
          {o.note?.() ?? ""}
        </text>
      </box>
      {o.extra?.()}
    </box>
  );

  const heading = (label: string, count?: number) => {
    const counted = count === undefined ? "" : ` ${count}`;
    return (
      <text fg={color.border} wrapMode="none" flexShrink={0} marginTop={1} selectable={false}>
        <span style={{ fg: color.dim }}>{label}</span>
        <span style={{ fg: color.notice }}>{counted}</span>
        {` ${"─".repeat(Math.max(0, inner() - 1 - Bun.stringWidth(label + counted)))}`}
      </text>
    );
  };
  const chip = (label: string, onClick: () => void, fg: string = color.bright) => (
    <box onMouseDown={left(onClick)} flexShrink={0} marginLeft={1}>
      <text selectable={false} wrapMode="none">
        <span style={{ fg, bg: color.mineBg }}>{` ${label} `}</span>
      </text>
    </box>
  );

  const ready = () =>
    props.next === undefined && "line" in props.view.start && props.view.steps.every((s) => s.done);
  const startLine = () => ("line" in props.view.start ? props.view.start.line : undefined);
  /** Who waits for a square besides the next. */
  const queued = () =>
    props.view.place.filter((t) => props.next?.kind !== "place" || t.id !== props.next.id);
  const maps = () => props.view.maps;
  const showMaps = () => maps().loaded === undefined || mapsOpen();

  /** Every step named, where they fit; else only the one to do now is. */
  const named = () =>
    props.view.steps.reduce((w, s) => w + 3 + Bun.stringWidth(s.label), 3) <= inner() + 1;
  const pip = (
    label: string,
    done: boolean,
    now: boolean,
    o: { always?: boolean; onClick?: () => void } = {},
  ) => (
    <text
      wrapMode="none"
      flexShrink={0}
      marginRight={1}
      selectable={false}
      {...(o.onClick !== undefined && { onMouseDown: left(o.onClick) })}
    >
      <span style={{ fg: done ? READY : now ? color.notice : color.border }}>
        {done ? "◆" : now ? "◈" : "◇"}
      </span>
      <span style={{ fg: done ? color.dim : now ? color.bright : color.border }}>
        {named() || now || o.always ? ` ${label}` : ""}
      </span>
    </text>
  );

  return (
    <box
      ref={(el: BoxRenderable) => (box = el)}
      onMouseDown={boxClick(() => box, title, props.onTitle)}
      border
      borderColor={props.next !== undefined ? NEXT : color.gm}
      title={title()}
      width={props.width}
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <For each={props.view.steps}>
          {(step, i) =>
            pip(
              step.label,
              step.done,
              !step.done && props.view.steps.slice(0, i()).every((s) => s.done),
            )
          }
        </For>
        {pip("▶", false, ready(), {
          always: true,
          onClick: () => {
            const line = startLine();
            if (line !== undefined) props.onStart(line);
          },
        })}
      </box>

      {/*
        What the next square does, Fight once everyone is placed, or the fight's round, in rows
        kept whatever shows, so the list under them never moves while the GM clicks down it.
      */}
      <box marginTop={1} height={SLOT_ROWS} flexShrink={0} flexDirection="column">
        <Show when={props.next}>
          {(next) => (
            <box flexDirection="row" flexShrink={0} height={props.pictures ? 4 : 2}>
              {bar(true, props.pictures ? 4 : 2)}
              <Show when={props.pictures} fallback={token(next().figure)}>
                <image
                  width={8}
                  height={4}
                  fit="fill"
                  protocol="kitty"
                  source={image(next().figure, 2)}
                />
              </Show>
              <box
                flexDirection="column"
                marginLeft={1}
                justifyContent="center"
                flexGrow={1}
                minWidth={0}
              >
                <text fg={color.bright} wrapMode="none" selectable={false}>
                  {fitName(next().name, inner() - (props.pictures ? 10 : 6))}
                </text>
                <text wrapMode="none" selectable={false}>
                  <span style={{ fg: color.notice }}>{added(next())}</span>
                  <span style={{ fg: NEXT }}>⌖</span>
                </text>
              </box>
            </box>
          )}
        </Show>
        <Show when={ready()}>
          <box
            flexDirection="row"
            flexShrink={0}
            onMouseDown={left(() => {
              const line = startLine();
              if (line !== undefined) props.onStart(line);
            })}
          >
            <text fg={READY} wrapMode="none" selectable={false}>
              {PLAY.join("\n")}
            </text>
            <box flexDirection="column" justifyContent="center" marginLeft={1}>
              <text fg={READY} wrapMode="none" selectable={false}>
                fight
              </text>
            </box>
          </box>
        </Show>
        <Show when={"note" in props.view.start && props.next === undefined}>
          <text fg={color.dim} wrapMode="none" flexShrink={0}>
            {"note" in props.view.start ? props.view.start.note : ""}
          </text>
        </Show>
      </box>

      <scrollbox ref={props.ref} scrollAcceleration={wheel} flexGrow={1}>
        <Show
          when={showMaps()}
          fallback={
            <>
              {heading("map")}
              <box flexDirection="row" height={1} flexShrink={0}>
                <text wrapMode="none" fg={color.text} flexGrow={1} minWidth={0}>
                  {fit(maps().loaded?.name ?? "", inner() - 9)}
                </text>
                <Show when={maps().loaded?.again}>
                  {(again) => chip("↻", () => props.onSend(again()), color.notice)}
                </Show>
                {chip("⇄", () => setMapsOpen(true), color.dim)}
              </box>
            </>
          }
        >
          {heading("maps")}
          <For each={maps().items}>
            {(item) => (
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                onMouseDown={left(() => {
                  setMapsOpen(false);
                  if (item.kind === "fill") props.onFill(item.line);
                  else void props.onSend(item.line);
                })}
              >
                <text wrapMode="none" selectable={false}>
                  <span
                    style={{ fg: item.line.startsWith("/map new") ? color.notice : color.text }}
                  >
                    {item.line.startsWith("/map new") ? "+ " : "  "}
                    {fit(item.label.replace(/^New,? ?/, ""), inner() - 2)}
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>

        <Show when={queued().length > 0}>
          {heading("to place", queued().length)}
          <For each={queued()}>
            {(t) =>
              entry({
                figure: t.figure,
                name: t.name,
                note: () => <span style={{ fg: color.notice }}>◌</span>,
                onClick: () => props.onArm({ kind: "token", id: t.id }),
              })
            }
          </For>
        </Show>

        <For each={props.view.sections}>
          {(section, s) => (
            <Show when={section.items.length > 0 || section.note !== undefined}>
              {heading(section.title)}
              <Show when={section.all}>
                {(all) => (
                  <box flexDirection="row" height={1} flexShrink={0}>
                    {chip("+ all", () => props.onAll(all()), color.heroes)}
                  </box>
                )}
              </Show>
              <Show when={section.note}>
                {(note) => (
                  <text fg={color.dim} wrapMode="none">
                    {fit(note(), inner())}
                  </text>
                )}
              </Show>
              <For each={section.items}>
                {(item, i) => {
                  const counted = () => {
                    const a = props.armed;
                    return a?.kind === "count" && a.section === s() && a.index === i()
                      ? a.n
                      : undefined;
                  };
                  const figure = item.figure;
                  if (figure === undefined)
                    return (
                      <box flexDirection="row" height={1} flexShrink={0}>
                        {chip(`+ ${item.label}`, () =>
                          item.kind === "fill"
                            ? props.onFill(item.line)
                            : void props.onSend(item.line),
                        )}
                      </box>
                    );
                  if (item.kind !== "count")
                    return entry({
                      figure,
                      name: item.label,
                      dim: true,
                      onClick: () => {
                        if (item.kind === "fill") return props.onFill(item.line);
                        // Who joins goes next, at once; a refusal puts them down again.
                        props.onArm({ kind: "token", id: figure.id });
                        void props.onSend(item.line).then((refused) => {
                          if (refused !== undefined) props.onArm(undefined);
                        });
                      },
                    });
                  return entry({
                    figure,
                    name: item.label,
                    marked: () => counted() !== undefined,
                    dim: item.note === undefined,
                    note: () =>
                      counted() !== undefined ? (
                        <span style={{ fg: color.notice }}>{`+${counted()}`}</span>
                      ) : (
                        <span style={{ fg: color.director }}>{item.note ?? ""}</span>
                      ),
                    onClick: () => props.onCount(s(), i(), 1),
                    extra: () => (
                      <Show when={counted() !== undefined}>
                        {chip("−", () => props.onCount(s(), i(), -1), color.notice)}
                      </Show>
                    ),
                  });
                }}
              </For>
            </Show>
          )}
        </For>
      </scrollbox>
    </box>
  );
}
