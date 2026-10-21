import { test } from "bun:test";
import { Effect, type Scope } from "effect";

/** A `bun test` case whose body is an Effect. It runs scoped, so finalizers run before the test ends. */
export const effect = <E>(
  name: string,
  body: () => Effect.Effect<unknown, E, Scope.Scope>,
  timeout?: number,
) => test(name, () => Effect.runPromise(Effect.scoped(Effect.suspend(body))), timeout);

/** Polls until `predicate` holds, failing the test after `ms`. */
export const waitFor = (what: string, predicate: () => boolean, ms = 3000) =>
  Effect.promise(async () => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(10);
    }
  });
