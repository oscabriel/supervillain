import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { type JSX, useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { Envelope } from "../game/events.ts"
import { parseInputLine } from "../game/input.ts"
import { actorLabel, type FeedEntry, type RoomState } from "../game/state.ts"
import { Roster } from "./Roster.tsx"

export interface RoomView {
  state: () => RoomState // Solid accessor fed from Room.state changes, batched ~16ms
  submit: (line: string) => Promise<string | undefined> // returns a refusal message, if any
  complete: (line: string) => string[]
  /** Actors connected right now; without it the header lists everyone the room has named. */
  present?: () => string[]
  /** Recent envelopes for the /state pane; without it the pane shows recent feed entries. */
  envelopes?: () => Envelope[]
}

type Notice = { kind: "refusal" | "help"; text: string }

const HINT = "Enter send · Tab complete · ↑↓ history · PgUp/PgDn scroll · /help · /state"
const DIM = "#808080"

function commonPrefix(items: string[]): string {
  if (items.length === 0) return ""
  let prefix = items[0]!
  for (const s of items) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return prefix
}

function feedColor(entry: FeedEntry, actor: string): string {
  switch (entry.kind) {
    case "dice.rolled":
      return "#56b6c2"
    case "creature.added":
    case "stamina.changed":
      return "#e5c07b"
    case "chat.posted":
    case "name.set":
      return entry.actor === actor ? "#ffffff" : "#c8c8c8"
  }
}

function debugText(state: RoomState, envelopes: Envelope[] | undefined): string {
  const recent = envelopes ? envelopes.slice(-6) : state.feed.slice(-6)
  const head = JSON.stringify({ ...state, feed: `[${state.feed.length} entries]` }, null, 2)
  const label = envelopes ? "last envelopes" : "last feed entries"
  return `${head}\n\n${label}:\n${recent.map((r) => JSON.stringify(r)).join("\n")}`
}

export function App(props: { view: RoomView; actor: string }): JSX.Element {
  let input: InputRenderable | undefined
  let feed: ScrollBoxRenderable | undefined
  let debug: ScrollBoxRenderable | undefined

  const [notice, setNotice] = createSignal<Notice | undefined>()
  const [candidates, setCandidates] = createSignal<string[]>([])
  const [showState, setShowState] = createSignal(false)
  const history: string[] = []
  let historyIndex = 0
  let draft = ""

  const state = () => props.view.state()
  const here = createMemo(() => {
    const s = state()
    const actors = props.view.present ? props.view.present() : [...new Set([props.actor, ...Object.keys(s.names)])]
    return actors.map((a) => (a === props.actor ? `${actorLabel(s, a)} (you)` : actorLabel(s, a))).join(", ")
  })

  const setLine = (line: string) => {
    if (!input) return
    input.value = line
    input.gotoBufferEnd()
  }

  async function submit(value: string) {
    const line = value.trim()
    setCandidates([])
    if (line === "") return
    history.push(line)
    historyIndex = history.length
    draft = ""
    setLine("")
    setNotice(undefined)

    const parsed = parseInputLine(line)
    if (parsed.kind === "state") return void setShowState(!showState())
    if (parsed.kind === "help") return void setNotice({ kind: "help", text: parsed.text })
    if (parsed.kind === "refusal") return void setNotice({ kind: "refusal", text: parsed.message })
    try {
      const refusal = await props.view.submit(line)
      if (refusal) setNotice({ kind: "refusal", text: refusal })
    } catch (e) {
      setNotice({ kind: "refusal", text: e instanceof Error ? e.message : String(e) })
    }
  }

  function complete() {
    const line = input?.value ?? ""
    const options = props.view.complete(line)
    if (options.length === 0) return setCandidates([])
    if (options.length === 1) {
      setCandidates([])
      return setLine(options[0]!)
    }
    const prefix = commonPrefix(options)
    if (prefix.length > line.length) setLine(prefix)
    setCandidates(options)
  }

  function recall(step: -1 | 1) {
    if (history.length === 0) return
    if (historyIndex === history.length) draft = input?.value ?? ""
    historyIndex = Math.min(Math.max(historyIndex + step, 0), history.length)
    setLine(historyIndex === history.length ? draft : history[historyIndex]!)
  }

  useKeyboard((key: KeyEvent) => {
    const plain = !key.ctrl && !key.meta && !key.shift
    if (key.name === "tab" && plain) {
      key.preventDefault()
      complete()
    } else if (key.name === "up" && plain) {
      key.preventDefault()
      recall(-1)
    } else if (key.name === "down" && plain) {
      key.preventDefault()
      recall(1)
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault()
      const target = showState() ? debug : feed
      target?.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport")
    } else if (key.name === "escape") {
      setNotice(undefined)
      setCandidates([])
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg="#e06c75">supervillain</text>
        <text fg={DIM}> PROTOTYPE · seq {state().seq} · </text>
        <text flexGrow={1} wrapMode="none" truncate>
          here: {here()}
        </text>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show
          when={showState()}
          fallback={<Roster creatures={state().creatures} />}
        >
          <box border title=" /state " width="50%" flexShrink={0}>
            <scrollbox ref={(el: ScrollBoxRenderable) => (debug = el)} flexGrow={1} paddingLeft={1}>
              <text fg="#98c379">{debugText(state(), props.view.envelopes?.())}</text>
            </scrollbox>
          </box>
        </Show>
        <box border title=" Feed " flexGrow={1} minWidth={0}>
          <scrollbox
            ref={(el: ScrollBoxRenderable) => (feed = el)}
            flexGrow={1}
            stickyScroll
            stickyStart="bottom"
            paddingLeft={1}
          >
            <For each={state().feed}>{(entry) => <text fg={feedColor(entry, props.actor)}>{entry.text}</text>}</For>
          </scrollbox>
        </box>
      </box>

      <Show when={notice()}>
        {(n: () => Notice) => (
          <box flexShrink={0} paddingLeft={1} paddingRight={1}>
            <text fg={n().kind === "refusal" ? "#e06c75" : "#c8c8c8"}>
              {n().kind === "refusal" ? `✗ ${n().text}` : n().text}
            </text>
          </box>
        )}
      </Show>

      <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={DIM} wrapMode="none" truncate>
          {candidates().length > 0 ? `Tab: ${candidates().map((c) => c.trim()).join("   ")}` : HINT}
        </text>
      </box>

      <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1}>
        <text fg="#e5c07b">{"> "}</text>
        <input
          ref={(el: InputRenderable) => (input = el)}
          flexGrow={1}
          focused
          placeholder="Say something, or /help"
          placeholderColor={DIM}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          // Solid wires onSubmit to the input's "enter" event, which carries the value as a string.
          onSubmit={(value: unknown) => void submit(String(value))}
        />
      </box>
    </box>
  )
}
