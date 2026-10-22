// PROTOTYPE, throwaway (branch prototype/map-art). Sets up the sample fight at the ford in a scratch
// campaign and hosts it, so the art map has something on it:
//
//   bun apps/supervillain/src/table/prototype-map-art/demo.ts
//
// The scratch folder is /tmp/sv-map-art (PROTOTYPE, wipe me); each run starts it over.
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Logger } from "effect";
import { runLine } from "../../host/line.ts";
import { tableServices } from "../../host/services.ts";

const dir = "/tmp/sv-map-art";
const root = join(import.meta.dir, "../../../../..");

const SETUP = [
  "/map ford-road",
  "/hero brann",
  "/hero kesh",
  "/hero wren",
  "/hero ilsa",
  "/add bandit-chief",
  "/add bandit-bruiser x2",
  "/add bandit-cutpurse x4",
  "/add bandit-slinger x4",
  "/place brann b5",
  "/place kesh c6",
  "/place wren b7",
  "/place ilsa d5",
  "/place bandit-chief p6",
  "/place bandit-bruiser-1 o5",
  "/place bandit-bruiser-2 o7",
  "/place bandit-cutpurse n6",
  "/place bandit-slinger r5",
  "/start",
  "/first heroes",
  "/turn brann",
];

await rm(dir, { recursive: true, force: true });
await cp(join(root, "examples/campaign"), dir, { recursive: true });
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(tableServices(dir).pipe(Layer.provide(Logger.layer([]))));
      for (const line of SETUP) {
        const reply = yield* runLine("gm", line).pipe(Effect.provideContext(context));
        const said = reply.kind === "done" ? reply.lines.length : JSON.stringify(reply);
        console.log(`${line}  →  ${typeof said === "number" ? "ok" : said}`);
      }
    }),
  ),
);

console.log(`
The fight is set up in ${dir}, in combat, on Brann's turn. Hosting it now: try /move brann f5,
/done, /turn kesh, /pr ... and watch the map. F2 cycles the map's look, F3 the image protocol,
F4 kitty's transport (zlib or raw).
Players (or you, in kitty, Ghostty or WezTerm): ssh -p 2399 ford@127.0.0.1
`);
const host = Bun.spawn(
  [
    "bun",
    "supervillain",
    "host",
    dir,
    "--room",
    "ford",
    "--port",
    "2399",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: { ...process.env, SV_MAP_ART: process.env.SV_MAP_ART ?? "painted" },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await host.exited);
