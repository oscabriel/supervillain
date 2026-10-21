import { describe, expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { claimRoom, forgetRoom, judgeClaim, readRooms, touchRoom } from "../../src/relay/rooms.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const GM_A = `SHA256:${"A".repeat(43)}`;
const GM_B = `SHA256:${"B".repeat(43)}`;
const GM_C = `SHA256:${"C".repeat(43)}`;
const DAY = 24 * 60 * 60 * 1000;
/** A moment to start the relay's clock at, so times in the file read as dates. */
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

/** Runs `body` on a test clock set to T0, so a test moves the relay's time itself. */
const atT0 = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    return yield* body;
  }).pipe(Effect.provide(TestClock.layer()));

const later = (ms: number) => TestClock.adjust(ms);

describe("the room registry", () => {
  effect("the first host key to claim a room holds it; another is told who does", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        expect(yield* readRooms(path)).toEqual({});
        expect(yield* claimRoom(path, "den", GM_A)).toEqual({
          holder: GM_A,
          claimed: true,
          dropped: [],
        });
        expect(yield* claimRoom(path, "den", GM_A)).toMatchObject({
          holder: GM_A,
          claimed: false,
        });
        expect(yield* claimRoom(path, "den", GM_B)).toMatchObject({
          holder: GM_A,
          claimed: false,
        });
        yield* later(1000);
        expect(yield* claimRoom(path, "attic", GM_B)).toMatchObject({
          holder: GM_B,
          claimed: true,
        });
        expect(yield* readRooms(path)).toEqual({
          den: { key: GM_A, linked: T0 },
          attic: { key: GM_B, linked: T0 + 1000 },
        });
        // Plain JSON a person can read: each room's host key and when a GM last linked it.
        expect(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))).toEqual({
          attic: { key: GM_B, linked: "2026-10-01T12:00:01.000Z" },
          den: { key: GM_A, linked: "2026-10-01T12:00:00.000Z" },
        });
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  effect("a claim's holder linking again, or its link ending, renews its time", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        yield* claimRoom(path, "den", GM_A);
        yield* later(DAY);
        yield* claimRoom(path, "den", GM_A);
        expect((yield* readRooms(path)).den).toEqual({ key: GM_A, linked: T0 + DAY });
        yield* later(DAY);
        yield* touchRoom(path, "den", GM_A);
        expect((yield* readRooms(path)).den).toEqual({ key: GM_A, linked: T0 + 2 * DAY });
        // Another key's link, or a room forgotten meanwhile, renews nothing.
        yield* later(DAY);
        yield* touchRoom(path, "den", GM_B);
        expect((yield* readRooms(path)).den?.linked).toBe(T0 + 2 * DAY);
        yield* forgetRoom(path, "den");
        yield* touchRoom(path, "den", GM_A);
        expect(yield* readRooms(path)).toEqual({});
      }),
    ),
  );

  effect("a claim no GM has linked for the expiry lapses, and the next host key claims it", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        const policy = { expireMs: 30 * DAY };
        yield* claimRoom(path, "den", GM_A, policy);
        yield* claimRoom(path, "attic", GM_A, policy);
        yield* later(30 * DAY);
        expect(yield* claimRoom(path, "den", GM_B, policy)).toMatchObject({
          holder: GM_A,
          claimed: false,
        });
        yield* later(1);
        expect(yield* claimRoom(path, "den", GM_B, policy)).toEqual({
          holder: GM_B,
          claimed: true,
          dropped: [
            { room: "attic", key: GM_A, linked: T0 },
            { room: "den", key: GM_A, linked: T0 },
          ],
        });
        // Lapsed claims leave the file when it's next written.
        expect(Object.keys(yield* readRooms(path))).toEqual(["den"]);
      }),
    ),
  );

  effect("a GM linked now keeps its room however long ago its link began", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        yield* claimRoom(path, "den", GM_A);
        yield* later(90 * DAY);
        const policy = { expireMs: 30 * DAY, linked: new Set(["den"]) };
        expect(yield* claimRoom(path, "den", GM_B, policy)).toMatchObject({
          holder: GM_A,
          claimed: false,
        });
        expect(yield* claimRoom(path, "attic", GM_B, policy)).toMatchObject({ dropped: [] });
        expect(Object.keys(yield* readRooms(path)).sort()).toEqual(["attic", "den"]);
      }),
    ),
  );

  effect("forget releases a claim, and the next host key claims it", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        yield* claimRoom(path, "den", GM_A);
        expect(yield* forgetRoom(path, "den")).toBe(GM_A);
        expect(yield* forgetRoom(path, "den")).toBeUndefined();
        expect(yield* claimRoom(path, "den", GM_B)).toMatchObject({
          holder: GM_B,
          claimed: true,
        });
      }),
    ),
  );

  effect("claims and forgets in flight together lose nothing, as from a relay and its forget", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "rooms.json");
      yield* claimRoom(path, "attic", GM_A);
      const rooms = Array.from({ length: 12 }, (_, i) => `room-${i}`);
      yield* Effect.all(
        [
          ...rooms.map((room) => claimRoom(path, room, GM_B)),
          ...rooms.map(() => forgetRoom(path, "attic")),
        ],
        { concurrency: "unbounded" },
      );
      const after = yield* readRooms(path);
      expect(Object.keys(after).sort()).toEqual([...rooms].sort());
    }),
  );

  effect("a full registry makes way by dropping its stalest claim with no GM linked now", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        yield* claimRoom(path, "den", GM_A);
        yield* later(DAY);
        yield* claimRoom(path, "attic", GM_B);
        yield* later(DAY);
        yield* claimRoom(path, "loft", GM_C);
        yield* later(DAY);
        // Den is stalest but linked now; attic is the stalest that isn't.
        const policy = { maxRooms: 3, linked: new Set(["den"]) };
        expect(yield* claimRoom(path, "cellar", GM_C, policy)).toEqual({
          holder: GM_C,
          claimed: true,
          dropped: [{ room: "attic", key: GM_B, linked: T0 + DAY }],
        });
        // A room already held is still answered, and costs nobody their claim.
        expect(yield* claimRoom(path, "den", GM_B, policy)).toMatchObject({
          holder: GM_A,
          claimed: false,
        });
        expect(Object.keys(yield* readRooms(path)).sort()).toEqual(["cellar", "den", "loft"]);
        // With every claim linked, nothing makes way: the claim is refused.
        const allLinked = { maxRooms: 3, linked: new Set(["cellar", "den", "loft"]) };
        expect(yield* claimRoom(path, "attic", GM_B, allLinked)).toEqual({ full: true });
        expect(Object.keys(yield* readRooms(path)).sort()).toEqual(["cellar", "den", "loft"]);
      }),
    ),
  );

  effect("judgeClaim says what a claim would do, without writing", () =>
    Effect.sync(() => {
      const rooms = {
        den: { key: GM_A, linked: T0 },
        attic: { key: GM_B, linked: T0 + DAY },
      };
      const now = T0 + 40 * DAY;
      expect(judgeClaim(rooms, "den", GM_A, now, {})).toEqual({ kind: "holds" });
      // Its own GM coming back to a lapsed claim holds it still, and claims nothing new.
      expect(judgeClaim(rooms, "den", GM_A, now, { expireMs: 30 * DAY })).toEqual({
        kind: "holds",
      });
      expect(judgeClaim(rooms, "den", GM_B, now, {})).toEqual({ kind: "held", holder: GM_A });
      expect(judgeClaim(rooms, "den", GM_B, now, { expireMs: 30 * DAY })).toEqual({
        kind: "free",
        drop: ["den", "attic"],
      });
      expect(judgeClaim(rooms, "loft", GM_C, now, { maxRooms: 2 })).toEqual({
        kind: "free",
        drop: ["den"],
      });
      expect(
        judgeClaim(rooms, "loft", GM_C, now, { maxRooms: 2, linked: new Set(["den", "attic"]) }),
      ).toEqual({ kind: "full" });
    }),
  );

  effect("a registry from before claims had times starts their clocks now", () =>
    atT0(
      Effect.gen(function* () {
        const path = join(yield* tempDir, "rooms.json");
        yield* Effect.promise(() => writeFile(path, JSON.stringify({ den: GM_A })));
        expect(yield* readRooms(path)).toEqual({ den: { key: GM_A, linked: T0 } });
        yield* claimRoom(path, "attic", GM_B);
        expect(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))).den).toEqual({
          key: GM_A,
          linked: "2026-10-01T12:00:00.000Z",
        });
      }),
    ),
  );

  effect("a damaged file is an error, never an empty registry that hands rooms out", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      for (const [name, text] of [
        ["garbage", "not json"],
        ["array", "[]"],
        ["bad-room", JSON.stringify({ "Bad Room": GM_A })],
        ["bad-key", JSON.stringify({ den: "ssh-ed25519 AAAA" })],
        ["bad-claim-key", JSON.stringify({ den: { key: "nope", linked: "2026-10-01" } })],
        ["bad-time", JSON.stringify({ den: { key: GM_A, linked: "last tuesday" } })],
        ["no-time", JSON.stringify({ den: { key: GM_A } })],
      ] as const) {
        const path = join(dir, `${name}.json`);
        yield* Effect.promise(() => writeFile(path, text));
        const error = yield* Effect.flip(readRooms(path));
        expect(error._tag).toBe("RoomsError");
        expect(error.message).toContain(path);
        expect(yield* Effect.flip(claimRoom(path, "den", GM_B))).toMatchObject({
          _tag: "RoomsError",
        });
      }
    }),
  );
});
