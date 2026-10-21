// Appends to the campaign in argv[2] as fast as it can, until killed. Says "ready" after the first append.
import { Effect } from "effect";
import { CampaignLog } from "../../src/index.ts";

const padding = "x".repeat(64 * 1024);

const program = Effect.gen(function* () {
  const log = yield* CampaignLog;
  let seq = log.envelopes.length;
  for (let batch = 0; ; batch++) {
    const size = (batch % 3) + 1;
    const envelopes = Array.from({ length: size }, () => ({
      actor: "gm",
      seq: ++seq,
      timestamp: new Date().toISOString(),
      type: "added",
      payload: { n: 1, padding },
    }));
    yield* log.append(envelopes);
    if (batch === 0) process.stdout.write("ready\n");
  }
});

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(CampaignLog.layer(process.argv[2]!)))));
