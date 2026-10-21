import { For, Show } from "solid-js"
import type { Creature } from "../game/state.ts"

const METER_CELLS = 10
const NAME_WIDTH = 12

/** `▐████▌    ` style meter: filled cells for remaining Stamina, clamped to 0..max. */
export function meter(stamina: number, max: number, cells = METER_CELLS): string {
  const fraction = max > 0 ? Math.min(Math.max(stamina / max, 0), 1) : 0
  const filled = stamina > 0 ? Math.max(1, Math.round(fraction * cells)) : 0
  return `▐${"█".repeat(filled)}${" ".repeat(cells - filled)}▌`
}

export function staminaColor(stamina: number, max: number): string {
  if (stamina <= 0) return "#808080"
  const fraction = stamina / max
  if (fraction > 0.5) return "#6fcf6f"
  if (fraction > 0.25) return "#e5c07b"
  return "#e06c75"
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

export function Roster(props: { creatures: Creature[] }) {
  return (
    <box border title=" Roster " width={35} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={props.creatures.length > 0} fallback={<text fg="#808080">No creatures yet.</text>}>
        <For each={props.creatures}>
          {(c) => (
            <box flexDirection="row" height={1}>
              <text>{fit(c.name, NAME_WIDTH)} </text>
              <text fg={staminaColor(c.stamina, c.max)}>{meter(c.stamina, c.max)}</text>
              <text fg={c.stamina <= 0 ? "#808080" : undefined}> {`${c.stamina}/${c.max}`}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
