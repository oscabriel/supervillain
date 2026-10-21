// Throwaway end-to-end probe for the relay (PROTOTYPE). Run: bun relay/_probe.ts
// GM @opentui/ssh server <- injected socket <- relay <- real OpenSSH client.
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextRenderable } from "@opentui/core"
import { createServer } from "@opentui/ssh"
import { Effect } from "effect"
import { listenAttachable, relayActor } from "./attach.ts"
import { dialRelay } from "./gm-link.ts"
import { fingerprintOf, startRelay } from "./relay.ts"

const dir = mkdtempSync(join(tmpdir(), "sv-relay-probe-"))
const playerKey = join(dir, "player")
Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", playerKey])
const playerFp = fingerprintOf(Buffer.from(readFileSync(`${playerKey}.pub`, "utf8").split(" ")[1]!, "base64"))
const expectedActor = `key:${playerFp}`

const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[P_^][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b./g, "")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const gmLog: string[] = []

async function sshSession(label: string, port: number, room = "probe", whileOpen?: () => void, extraArgs: string[] = []) {
  let output = ""
  let lastChunkAt = 0
  const proc = Bun.spawn(
    ["ssh", "-F", "/dev/null", "-tt", "-p", String(port),
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", ...extraArgs, "-i", playerKey, `${room}@127.0.0.1`],
    {
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: 100,
        rows: 30,
        data: (_t, data) => {
          output += Buffer.from(data).toString("utf8")
          lastChunkAt = performance.now()
        },
      },
    },
  )
  const terminal = proc.terminal!
  let exitedEarly = false
  void proc.exited.then(() => (exitedEarly = true))
  const waitFor = async (pred: () => boolean, ms: number) => {
    const end = performance.now() + ms
    while (!pred() && performance.now() < end) await sleep(5)
    return pred()
  }
  const quiet = async (ms: number) => {
    while (performance.now() - lastChunkAt < ms) await sleep(5)
  }

  const t0 = performance.now()
  const sawHello = await waitFor(() => stripAnsi(output).includes(`hello ${expectedActor}`) || exitedEarly, 10_000) && !exitedEarly
  const helloMs = performance.now() - t0
  const line = stripAnsi(output).match(/hello \S+ via \w+/)?.[0]
  console.log(`[${label}] hello seen=${sawHello} after ${helloMs.toFixed(0)}ms: ${JSON.stringify(line)}`)
  if (!sawHello) console.log(`[${label}] raw output: ${JSON.stringify(output.slice(0, 600))}`)

  const echoes: number[] = []
  if (sawHello) {
    await quiet(300)
    for (let i = 0; i < 30; i++) {
      const before = output.length
      const sent = performance.now()
      terminal.write(i % 2 ? "a" : "b")
      if (await waitFor(() => output.length > before, 2000)) echoes.push(lastChunkAt - sent)
      await quiet(60)
    }
    const gmBefore = gmLog.length
    terminal.resize(120, 40)
    await waitFor(() => gmLog.slice(gmBefore).some((l) => l.includes("120x40")), 2000)
    console.log(`[${label}] resize forwarded: ${gmLog.slice(gmBefore).find((l) => l.includes("120x40")) ?? "NO"}`)
  }
  console.log(
    `[${label}] keystroke->first output byte, n=${echoes.length}: median ${echoes.length ? median(echoes).toFixed(2) : "-"}ms, min ${echoes.length ? Math.min(...echoes).toFixed(2) : "-"}ms, max ${echoes.length ? Math.max(...echoes).toFixed(2) : "-"}ms`,
  )
  if (whileOpen && sawHello) {
    const before = performance.now()
    whileOpen()
    const code = await Promise.race([proc.exited, sleep(3000).then(() => "timeout")])
    console.log(`[${label}] after GM link dropped, ssh exit=${code} in ${(performance.now() - before).toFixed(0)}ms, saw notice=${stripAnsi(output).includes("The table went away.")}`)
    return { sawHello, echoes, output }
  }
  if (!sawHello) console.log(`[${label}] text: ${JSON.stringify(stripAnsi(output).trim().slice(0, 200))}`)
  terminal.write("q")
  const exited = await Promise.race([proc.exited, sleep(3000).then(() => "timeout")])
  console.log(`[${label}] ssh exit: ${exited}`)
  if (exited === "timeout") proc.kill()
  return { sawHello, echoes, output }
}

const program = Effect.gen(function* () {
  const relay = yield* startRelay({
    playerPort: 0,
    gmPort: 0,
    hostKeyPath: join(dir, "relay_host_key"),
    relayKeyPath: join(dir, "relay_client_key"),
  })

  const server = createServer({
    hostKey: { path: join(dir, "gm_host_key") },
    auth: { publicKey: "any" },
    startupBanner: false,
    limits: { session: { perConnection: 16 } },
  })
    .use(relayActor(relay.relayFingerprint))
    .serve((session) => {
      const { renderer } = session
      const { actor, via } = session.context
      gmLog.push(`open ${actor} via ${via} ${session.cols}x${session.rows} term=${session.term}`)
      renderer.root.add(new TextRenderable(renderer, { content: `hello ${actor} via ${via}` }))
      const echo = new TextRenderable(renderer, { content: "echo 0" })
      renderer.root.add(echo)
      let n = 0
      session.onResize((c, r) => gmLog.push(`resize ${via} ${c}x${r}`))
      renderer.keyInput.on("keypress", (key) => {
        if (key.name === "q") return session.end()
        echo.content = `echo ${++n} ${key.name}`
      })
    })
  const attachable = yield* Effect.acquireRelease(
    Effect.promise(() => listenAttachable(server, 0, "127.0.0.1")),
    () => Effect.promise(() => server.close()),
  )
  const { socket: gmSocket } = yield* dialRelay({ relayHost: "127.0.0.1", gmPort: relay.gmPort, room: "probe", onSocket: attachable.attach })
  yield* Effect.promise(async () => {
    while (!relay.rooms().includes("probe")) await sleep(10)
  })

  const viaRelay = yield* Effect.promise(() => sshSession("relay", relay.playerPort))
  const direct = yield* Effect.promise(() => sshSession("direct", attachable.info.port))
  // A direct client claiming SV_ACTOR must be ignored: its own key fingerprint wins.
  yield* Effect.promise(() =>
    sshSession("direct-spoof", attachable.info.port, "probe", undefined, ["-o", "SetEnv=SV_ACTOR=key:SHA256:spoofed"]),
  )
  const both = yield* Effect.promise(() =>
    Promise.all([sshSession("relay-a", relay.playerPort), sshSession("relay-b", relay.playerPort)]),
  )
  console.log(`two players at once on one GM link: ${both.every((r) => r.sawHello)}`)
  yield* Effect.promise(() => sshSession("wrong-room", relay.playerPort, "nope"))
  yield* Effect.promise(() => sshSession("drop", relay.playerPort, "probe", () => gmSocket.destroy()))
  console.log("gm log:\n  " + gmLog.join("\n  "))
  if (viaRelay.echoes.length && direct.echoes.length) {
    console.log(`added latency (median relay - median direct): ${(median(viaRelay.echoes) - median(direct.echoes)).toFixed(2)}ms`)
  }
  console.log(viaRelay.sawHello && direct.sawHello ? "PROBE OK" : "PROBE FAILED")
})

await Effect.runPromise(Effect.scoped(program))
console.log("scope closed: relay listeners and GM server released")
process.exit(0)
