// Headless preview: renders App over an in-memory room and prints frames.
// Run: bun table/_preview.tsx   (bunfig.toml preloads the Solid transform)
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { Envelope } from "../game/events.ts"
import { completeLine, parseInputLine } from "../game/input.ts"
import { type Command, apply, decide } from "../game/rules.ts"
import { initialState, type RoomState } from "../game/state.ts"
import { App, type RoomView } from "./App.tsx"

const PLAYER = "key:SHA256:3f9a2b1cQx7hPzK0aLmN"

function fakeRoom() {
  const [state, setState] = createSignal<RoomState>(initialState)
  const [envelopes, setEnvelopes] = createSignal<Envelope[]>([])
  let seed = 7
  const dice = (sides: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed % sides) + 1
  }

  const run = (actor: string, command: Command): string | undefined => {
    const decision = decide(state(), actor, command, dice)
    if ("refusal" in decision) return decision.refusal
    let next = state()
    const written: Envelope[] = []
    for (const e of decision.events) {
      const env: Envelope = { actor, seq: next.seq + 1, timestamp: new Date(0).toISOString(), ...e }
      next = apply(next, env)
      written.push(env)
    }
    setState(next)
    setEnvelopes([...envelopes(), ...written].slice(-50))
    return undefined
  }

  const viewFor = (actor: string): RoomView => ({
    state,
    envelopes,
    present: () => ["gm", PLAYER],
    complete: (line) => completeLine(state(), line),
    submit: async (line) => {
      const parsed = parseInputLine(line)
      if (parsed.kind === "refusal") return parsed.message
      if (parsed.kind !== "command") return undefined
      return run(actor, parsed.command)
    },
  })
  return { run, viewFor }
}

async function preview(width: number, height: number, actor: string) {
  const room = fakeRoom()
  room.run("gm", { type: "name", name: "Director" })
  room.run(PLAYER, { type: "name", name: "Aria" })
  room.run("gm", { type: "add", name: "Goblin", stamina: 15 })
  room.run("gm", { type: "add", name: "Goblin Archer", stamina: 12 })
  room.run("gm", { type: "add", name: "Ogre", stamina: 40 })
  room.run("gm", { type: "dmg", target: "goblin", amount: 6 })
  room.run("gm", { type: "dmg", target: "goblin archer", amount: 9 })
  room.run("gm", { type: "chat", text: "The goblins spill out of the culvert." })

  const t = await testRender(() => <App view={room.viewFor(actor)} actor={actor} />, { width, height })
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20))
    await t.renderOnce()
  }

  await t.mockInput.typeText("I draw my blade and step forward.")
  t.mockInput.pressEnter()
  await settle()
  await t.mockInput.typeText("/roll 2d10")
  t.mockInput.pressEnter()
  await settle()
  await t.mockInput.typeText("/dmg ogre 3") // refused: player is not the GM
  t.mockInput.pressEnter()
  await settle()
  await t.mockInput.typeText("/ro")
  t.mockInput.pressTab()
  await settle()

  console.log(`----- ${width}x${height} as ${actor} -----`)
  console.log(t.captureCharFrame())

  if (actor === "gm") {
    t.mockInput.pressArrow("up") // history recall stays in the input line
    await settle()
    for (let i = 0; i < 12; i++) t.mockInput.pressBackspace()
    await t.mockInput.typeText("/dmg gob")
    t.mockInput.pressTab()
    await settle()
    console.log(`----- ${width}x${height} as gm, Tab on '/dmg gob' -----`)
    console.log(t.captureCharFrame())

    for (let i = 0; i < 30; i++) t.mockInput.pressBackspace()
    await t.mockInput.typeText("/state")
    t.mockInput.pressEnter()
    await settle()
    console.log(`----- ${width}x${height} as gm, /state -----`)
    console.log(t.captureCharFrame())

    console.log(`----- ${width}x${height} as gm, /state off then /help -----`)
    await t.mockInput.typeText("/state")
    t.mockInput.pressEnter()
    await settle()
    await t.mockInput.typeText("/help")
    t.mockInput.pressEnter()
    await settle()
    console.log(t.captureCharFrame())

    t.mockInput.pressKey("\u001b[5~") // PgUp scrolls the feed, the input keeps its text
    await settle()
    console.log(`----- ${width}x${height} as gm, PgUp -----`)
    console.log(t.captureCharFrame().split("\n").slice(0, 10).join("\n"))
  }
  await t.dispose()
}

await preview(100, 30, PLAYER)
await preview(80, 24, "gm")
process.exit(0)
