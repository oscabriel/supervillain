import { Context, Effect, Layer, Schema } from "effect";
import { type SetCharacter, SetCharacterSchema } from "../game/index.ts";
import { cleanText } from "../game/text.ts";

/** set.world's free, keyless character roll: `?seed=<n>` gives the same character every time. */
export const ROLL_URL = "https://set.world/api/roll/character";

/** How long a roll may take before the table gives up on it. */
const TIMEOUT = "10 seconds";

/** A roll that didn't come back as a character the table can keep. */
export class SetWorldError extends Schema.TaggedError<SetWorldError>()("SetWorldError", {
  message: Schema.String,
}) {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What the table reads of a roll: the fields the rules and /sheet need. Anything else set.world
 * sends is left out, so the event keeps the part the table uses, not the whole answer.
 */
const RollResponse = Schema.Struct({
  seed: Schema.Int,
  contentVersion: Schema.String,
  class: Schema.Struct({ name: Schema.String, flavor: Schema.String, mainhand: Schema.String }),
  powerRating: Schema.Finite,
  finalStats: Schema.Record(Schema.String, Schema.Finite),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  equipment: Schema.Record(Schema.String, Schema.Unknown),
});

/** Every named item in the equipment: one item to a slot, or a list (two hands, two rings). */
function gearOf(equipment: Readonly<Record<string, unknown>>): SetCharacter["gear"] {
  const gear: Array<{ slot: string; name: string }> = [];
  for (const [slot, held] of Object.entries(equipment))
    for (const item of Array.isArray(held) ? held : [held]) {
      const name =
        typeof item === "object" && item !== null ? (item as { name?: unknown }).name : undefined;
      if (typeof name === "string" && cleanText(name) !== "")
        gear.push({ slot: cleanText(slot), name: cleanText(name) });
    }
  return gear;
}

/**
 * The part of a `/api/roll/character` answer the table keeps, checked against what the rules
 * need: a roll for another seed, or one missing an attribute the fight reads, is refused.
 */
export const decodeRoll = (
  seed: number,
  body: unknown,
): Effect.Effect<SetCharacter, SetWorldError> =>
  Effect.gen(function* () {
    // A schema's message runs over lines ("Expected string\n  at [\"class\"][\"name\"]"): one is
    // enough for a refusal.
    const changed = (why: string) =>
      new SetWorldError({
        message: `set.world's answer isn't a character the table can read: ${why.replace(/\s*\n\s*/g, " ")}`,
      });
    const roll = yield* Schema.decodeUnknownEffect(RollResponse)(body).pipe(
      Effect.mapError((e) => changed(e.message)),
    );
    if (roll.seed !== seed) return yield* changed(`it rolled seed ${roll.seed}, not ${seed}`);
    const attributes = Object.fromEntries(
      Object.entries(roll.attributes).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
    return yield* Schema.decodeUnknownEffect(SetCharacterSchema)({
      seed: roll.seed,
      contentVersion: cleanText(roll.contentVersion),
      className: cleanText(roll.class.name),
      flavor: cleanText(roll.class.flavor),
      mainhand: cleanText(roll.class.mainhand).toLowerCase(),
      powerRating: roll.powerRating,
      finalStats: roll.finalStats,
      attributes,
      gear: gearOf(roll.equipment),
    }).pipe(Effect.mapError((e) => changed(e.message)));
  });

/** What set.world said was wrong, from its `{ error: { message } }`, if it said. */
const errorOf = (body: unknown): string => {
  const error = (body as { error?: { message?: unknown } } | undefined)?.error;
  return typeof error?.message === "string" ? `: ${cleanText(error.message)}` : "";
};

/**
 * set.world, where fighters are rolled: the host asks for a seed's character when the GM types
 * /recruit or /foe, and puts the part it keeps in the command, so the event carries it and replay
 * never fetches.
 */
export class SetWorld extends Context.Service<
  SetWorld,
  {
    /** The character set.world rolls for `seed` (0 to 2³² − 1). */
    readonly roll: (seed: number) => Effect.Effect<SetCharacter, SetWorldError>;
  }
>()("supervillain/host/SetWorld") {
  /** The live API, over HTTPS, given ten seconds to answer. */
  static readonly layer: Layer.Layer<SetWorld> = Layer.succeed(
    SetWorld,
    SetWorld.of({
      roll: (seed) =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${ROLL_URL}?seed=${seed}`, {
              signal,
              headers: { accept: "application/json" },
            });
            const body: unknown = await response.json().catch(() => undefined);
            return { ok: response.ok, status: response.status, body };
          },
          catch: (e) => new SetWorldError({ message: `couldn't reach set.world: ${messageOf(e)}` }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: TIMEOUT,
            orElse: () =>
              Effect.fail(new SetWorldError({ message: `set.world didn't answer in ${TIMEOUT}` })),
          }),
          Effect.flatMap(({ ok, status, body }) =>
            ok
              ? decodeRoll(seed, body)
              : Effect.fail(
                  new SetWorldError({ message: `set.world answered ${status}${errorOf(body)}` }),
                ),
          ),
          Effect.tap(() => Effect.logInfo(`rolled set.world seed ${seed}`)),
        ),
    }),
  );

  /**
   * A set.world that answers from recorded responses, for tests: `answer(seed)` is the JSON the
   * API gave for that seed, or undefined for a seed it has none for (answered as a 404).
   */
  static readonly answering = (answer: (seed: number) => unknown): Layer.Layer<SetWorld> =>
    Layer.succeed(
      SetWorld,
      SetWorld.of({
        roll: (seed) => {
          const body = answer(seed);
          return body === undefined
            ? Effect.fail(new SetWorldError({ message: "set.world answered 404" }))
            : decodeRoll(seed, body);
        },
      }),
    );
}
