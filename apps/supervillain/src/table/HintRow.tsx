import { For, Show } from "solid-js";
import type { Completion } from "./input.ts";
import { color } from "./theme.ts";

/** One dim row under the feed: what the keys do now, or the Tab candidates with the current one lit. */
export function HintRow(props: { hint: string; completion: Completion | undefined }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" truncate>
        <Show
          when={props.completion}
          fallback={<span style={{ fg: color.dim }}>{props.hint}</span>}
        >
          {(c) => (
            <>
              <span style={{ fg: color.dim }}>Tab:</span>
              <For each={c().candidates}>
                {(candidate, i) => (
                  <>
                    <span>{"  "}</span>
                    <span
                      style={
                        i() === c().index
                          ? { fg: color.cursorFg, bg: color.cursorBg }
                          : { fg: color.dim }
                      }
                    >
                      {candidate.trim()}
                    </span>
                  </>
                )}
              </For>
            </>
          )}
        </Show>
      </text>
    </box>
  );
}
