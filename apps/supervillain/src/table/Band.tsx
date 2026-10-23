import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For, Show } from "solid-js";
import { bandLayout, type Segment, type Tone } from "./band.ts";
import { keepLines } from "./keep.ts";
import { marked } from "./panels.ts";
import { color, people, personColor, personLabel } from "./theme.ts";
import type { CombatView, Present } from "./view.ts";

const TONES: Readonly<Record<Tone, string>> = {
  text: color.text,
  dim: color.dim,
  heroes: color.heroes,
  director: color.director,
  acting: color.bright,
  healthy: color.healthy,
  winded: color.winded,
  dying: color.dying,
  dead: color.dim,
  temp: color.dice,
};

/** Border, padding and the border again: what the band's box takes from the screen. */
export const BAND_FRAME = { width: 4, height: 2 } as const;

const styleOf = (s: Segment) =>
  s.mine
    ? { fg: color.you, bg: color.mineBg, bold: true }
    : { fg: TONES[s.tone], bold: s.tone === "acting" };

/**
 * The band above the feed. With a Draw Steel view it holds initiative and Stamina meters
 * (`▶ Vex ▐████░░▌ 14/21 +5 · slowed (EoT)`) in at most `maxHeight` rows, or the party outside
 * combat; without one it shows who is at the table, compactly, and, to a GM sitting alone, how
 * players join.
 */
export function Band(props: {
  me: string;
  present: ReadonlyArray<Present>;
  joinHint?: string;
  /** Said instead of `players join with: <joinHint>`, e.g. `relay: connecting…`. */
  joinNote?: string | undefined;
  combat?: CombatView | undefined;
  maxHeight: number;
  /** A reply pane shares the screen: creatures give way and no hero's row is cut. */
  heroesWhole?: boolean;
  /** The panel's key, leading the title (`¹`). */
  mark?: string | undefined;
}) {
  return (
    <Show when={props.combat} fallback={<Presence {...props} />}>
      {(combat) => (
        <Combat
          combat={combat()}
          maxHeight={props.maxHeight}
          heroesWhole={props.heroesWhole ?? false}
          mark={props.mark}
        />
      )}
    </Show>
  );
}

function Combat(props: {
  combat: CombatView;
  maxHeight: number;
  heroesWhole: boolean;
  mark: string | undefined;
}) {
  const size = useTerminalDimensions();
  const keep = keepLines<Segment>();
  const layout = createMemo(() => {
    const laid = bandLayout(
      props.combat,
      size().width - BAND_FRAME.width,
      props.maxHeight - BAND_FRAME.height,
      { heroesWhole: props.heroesWhole },
    );
    return { ...laid, lines: keep(laid.lines) };
  });
  return (
    <box
      border
      borderColor={props.combat.active ? color.brand : color.border}
      title={marked(layout().title, props.mark)}
      bottomTitle={layout().more > 0 ? ` +${layout().more} more ` : ""}
      bottomTitleAlignment="right"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={layout().lines.length > 0} fallback={<text fg={color.dim}>no heroes yet</text>}>
        <For each={layout().lines}>
          {(line) => (
            <text wrapMode="none">
              <For each={line}>{(s) => <span style={styleOf(s)}>{s.text}</span>}</For>
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

function Presence(props: {
  me: string;
  present: ReadonlyArray<Present>;
  joinHint?: string;
  joinNote?: string | undefined;
  mark?: string | undefined;
}) {
  const alone = () => people(props.present).every((p) => p.actor === props.me);
  const note = () =>
    props.joinNote ??
    (props.joinHint === undefined ? undefined : `players join with: ${props.joinHint}`);
  return (
    <box
      border
      borderColor={color.border}
      title={marked(" at the table ", props.mark)}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="word">
        <Show
          when={people(props.present).length > 0}
          fallback={<span style={{ fg: color.dim }}>nobody yet</span>}
        >
          <For each={people(props.present)}>
            {(p, i) => (
              <span style={{ fg: personColor(p, props.me) }}>
                {`${i() > 0 ? "   " : ""}${p.gm ? "◆" : "●"} ${personLabel(p, props.me)}`}
              </span>
            )}
          </For>
        </Show>
        <Show when={alone() ? note() : undefined}>
          {(text) => <span style={{ fg: color.dim }}>{`   ${text()}`}</span>}
        </Show>
      </text>
    </box>
  );
}
