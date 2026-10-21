import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import { color, fitLabels, people, personColor, personLabel } from "./theme.ts";
import type { Present } from "./view.ts";

/** The padding either side of the header row. */
const PADDING = 2;

/**
 * One row: the room, and who is here with the GM marked. Labels that don't fit are dropped whole
 * and counted ("+2"), never cut in the middle; the seat's own label always stays.
 */
export function Header(props: { room: string; me: string; present: ReadonlyArray<Present> }) {
  const size = useTerminalDimensions();
  const lead = () => `supervillain · ${props.room}   here: `;
  const fitted = () => {
    const here = people(props.present);
    const labels = here.map((p) => personLabel(p, props.me));
    const { shown, more } = fitLabels(
      labels,
      size().width - PADDING - Bun.stringWidth(lead()),
      here.findIndex((p) => p.actor === props.me),
    );
    return { shown: shown.map((i) => here[i]!), more };
  };
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: color.brand, bold: true }}>supervillain</span>
        <span style={{ fg: color.dim }}>{" · "}</span>
        <span style={{ fg: color.bright, bold: true }}>{props.room}</span>
        <span style={{ fg: color.dim }}>{"   here: "}</span>
        <For each={fitted().shown}>
          {(p, i) => (
            <span style={{ fg: personColor(p, props.me) }}>
              {`${i() > 0 ? ", " : ""}${personLabel(p, props.me)}`}
            </span>
          )}
        </For>
        <Show when={fitted().more > 0}>
          <span
            style={{ fg: color.dim }}
          >{`${fitted().shown.length > 0 ? ", " : ""}+${fitted().more}`}</span>
        </Show>
      </text>
    </box>
  );
}
