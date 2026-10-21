import { For, Show } from "solid-js";
import { color, people, personColor, personLabel } from "./theme.ts";
import type { Present } from "./view.ts";

/**
 * The band above the feed. Draw Steel fills it with initiative and Stamina meters
 * (`Vex ▐██████▌ 14/21 · slowed`); until then it shows who is at the table, compactly, and, to a
 * GM sitting alone, how players join.
 */
export function Band(props: { me: string; present: ReadonlyArray<Present>; joinHint?: string }) {
  const alone = () => people(props.present).every((p) => p.actor === props.me);
  return (
    <box
      border
      borderColor={color.border}
      title=" at the table "
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
        <Show when={props.joinHint !== undefined && alone()}>
          <span style={{ fg: color.dim }}>{`   players join with: ${props.joinHint}`}</span>
        </Show>
      </text>
    </box>
  );
}
