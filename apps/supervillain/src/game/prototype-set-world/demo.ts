// PROTOTYPE, throwaway (branch prototype/set-world). Rolls a party and foes at set.world, puts them
// on the ford in a scratch campaign, starts the fight and hosts it:
//
//   bun apps/supervillain/src/game/prototype-set-world/demo.ts
//
// The scratch folder is /tmp/sv-set-world (PROTOTYPE, wipe me); each run starts it over.
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Logger } from "effect";
import { runLine } from "../../host/line.ts";
import { tableServices } from "../../host/services.ts";
import { plainText } from "../index.ts";

const dir = "/tmp/sv-set-world";
const root = join(import.meta.dir, "../../../../..");

const SETUP = [
  "/arena ford-road",
  "/recruit Ada 101",
  "/recruit Sky 611",
  "/recruit Wix 7",
  "/recruit Dee 404",
  "/foe Grub 501",
  "/foe Mog 502",
  "/foe Nix 503",
  "/put Ada b5",
  "/put Sky c6",
  "/put Wix b7",
  "/put Dee d5",
  "/put Grub p6",
  "/put Mog o5",
  "/put Nix r7",
  "/fight",
];

await rm(dir, { recursive: true, force: true });
await cp(join(root, "examples/campaign"), dir, { recursive: true });
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(tableServices(dir).pipe(Layer.provide(Logger.layer([]))));
      for (const line of SETUP) {
        const reply = yield* runLine("gm", line).pipe(Effect.provideContext(context));
        if (reply.kind !== "done") console.log(`${line}  →  ${JSON.stringify(reply)}`);
        else for (const l of reply.lines) console.log(`${line}  →  ${plainText(l)}`);
      }
    }),
  ),
);

console.log(`
A Set fight is set up in ${dir}: four party members and three foes rolled by set.world (fixed
seeds), on the ford, and the first turn by initiative has begun. Try /sheet ada, /go <who> <square>,
/hit <who> <target>, /next. Players: ssh -p 2400 ford@127.0.0.1, then /take <name>.
F2 cycles the map's look (painted by default).
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
    "2400",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: { ...process.env, SV_MAP_ART: process.env.SV_MAP_ART ?? "painted" },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await host.exited);
