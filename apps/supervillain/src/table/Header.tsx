import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { color, people, personColor, personLabel } from "./theme.ts";
import type { Present } from "./view.ts";

/** One row: the room, and who is here with the GM marked. */
export function Header(props: { room: string; me: string; present: ReadonlyArray<Present> }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: color.brand, attributes: TextAttributes.BOLD }}>supervillain</span>
        <span style={{ fg: color.dim }}>{" · "}</span>
        <span style={{ fg: color.bright, attributes: TextAttributes.BOLD }}>{props.room}</span>
        <span style={{ fg: color.dim }}>{"   here: "}</span>
        <For each={people(props.present)}>
          {(p, i) => (
            <span style={{ fg: personColor(p, props.me) }}>
              {`${i() > 0 ? ", " : ""}${personLabel(p, props.me)}`}
            </span>
          )}
        </For>
      </text>
    </box>
  );
}
