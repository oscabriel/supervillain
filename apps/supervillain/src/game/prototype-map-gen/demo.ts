// PROTOTYPE, throwaway (branch prototype/set-world). Generates a battlemap in MEKMODE letters, sets
// up the sample fight on it (heroes on the west edge, bandits on the east) in a scratch campaign,
// and hosts it with the painted look:
//
//   bun apps/supervillain/src/game/prototype-map-gen/demo.ts [crossing|keep] [seed]
//
// The scratch folder is /tmp/sv-map-gen (PROTOTYPE, wipe me); each run starts it over. The map is
// written to its maps/ folder, where you can read it, edit it and load it again with /map.
import { cp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Logger } from "effect";
import { formatSquare } from "../drawSteel/map.ts";
import { runLine } from "../../host/line.ts";
import { tableServices } from "../../host/services.ts";
import { plainText } from "../index.ts";
import { generate, KINDS, type Kind, mapFile } from "./generate.ts";

const dir = "/tmp/sv-map-gen";
const root = join(import.meta.dir, "../../../../..");
const kind = (KINDS as ReadonlyArray<string>).includes(process.argv[2] ?? "")
  ? (process.argv[2] as Kind)
  : "crossing";
const seed = Number(process.argv[3] ?? "") || 1;
const map = generate(kind, seed);
const id = `${kind}-${seed}`;

await rm(dir, { recursive: true, force: true });
await cp(join(root, "examples/campaign"), dir, { recursive: true });
await writeFile(join(dir, "maps", `${id}.txt`), `${mapFile(map)}\n`);

const west = map.deploy.west.map(formatSquare);
const east = map.deploy.east.map(formatSquare);
const SETUP = [
  `/map ${id}`,
  "/hero brann",
  "/hero kesh",
  "/hero wren",
  "/hero ilsa",
  "/add bandit-chief",
  "/add bandit-bruiser x2",
  "/add bandit-slinger x4",
  `/place brann ${west[0]}`,
  `/place kesh ${west[1]}`,
  `/place wren ${west[2]}`,
  `/place ilsa ${west[3]}`,
  `/place bandit-chief ${east[0]}`,
  `/place bandit-bruiser-1 ${east[1]}`,
  `/place bandit-bruiser-2 ${east[2]}`,
  `/place bandit-slinger ${east[3]}`,
  "/start",
  "/first heroes",
  "/turn brann",
];
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(tableServices(dir).pipe(Layer.provide(Logger.layer([]))));
      for (const line of SETUP) {
        const reply = yield* runLine("gm", line).pipe(Effect.provideContext(context));
        if (reply.kind !== "done") console.log(`${line}  →  ${JSON.stringify(reply)}`);
      }
    }),
  ),
);

console.log(`${map.name} (${kind}, seed ${seed}), written to ${dir}/maps/${id}.txt:\n`);
for (const line of map.lines) console.log(`  ${line}`);
console.log(`
The sample fight is set up on it, on Brann's turn. Players: ssh -p 2401 ford@127.0.0.1.
F2 cycles the map's look (painted by default); the text look shows what the rules see.
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
    "2401",
    ...process.argv.slice(4),
  ],
  {
    cwd: root,
    env: { ...process.env, SV_MAP_ART: process.env.SV_MAP_ART ?? "painted" },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await host.exited);
