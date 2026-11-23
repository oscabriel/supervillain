import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun";
import { Clock, Console, DateTime, Effect, Layer, Ref } from "effect";

import { CampaignLog } from "../../src/index.ts";

const padding = "x".repeat(64 * 1024);

const dir = process.argv[2] ?? "";

const program = Effect.gen(function* () {
	const log = yield* CampaignLog;
	const opened = yield* log.lines(0);
	const progress = yield* Ref.make({ batch: 0, seq: opened.length });

	const step = Effect.gen(function* () {
		const { batch, seq } = yield* Ref.get(progress);
		const size = (batch % 3) + 1;
		const now = yield* Clock.currentTimeMillis;
		const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));

		const lines = Array.from({ length: size }, (_, index) => ({
			actor: "gm",
			seq: seq + index + 1,
			timestamp,
			type: "added",
			payload: { n: 1, padding },
		}));

		yield* log.append(lines);
		yield* Ref.set(progress, { batch: batch + 1, seq: seq + size });

		if (batch === 0) {
			yield* Console.log("ready");
		}
	});

	return yield* Effect.forever(step);
});

BunRuntime.runMain(
	program.pipe(
		Effect.scoped,
		Effect.provide(
			CampaignLog.layer(dir).pipe(
				Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
			)
		)
	)
);
