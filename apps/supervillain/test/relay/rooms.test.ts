import { describe, expect } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { claimRoom, forgetRoom, readRooms } from "../../src/relay/rooms.ts";
import { effect } from "../host/effect.ts";
import { tempDir } from "../host/tempDir.ts";

const GM_A = `SHA256:${"A".repeat(43)}`;
const GM_B = `SHA256:${"B".repeat(43)}`;

describe("the room registry", () => {
  effect("the first host key to claim a room holds it; another is told who does", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "rooms.json");
      expect(yield* readRooms(path)).toEqual({});
      expect(yield* claimRoom(path, "den", GM_A)).toEqual({ holder: GM_A, claimed: true });
      expect(yield* claimRoom(path, "den", GM_A)).toEqual({ holder: GM_A, claimed: false });
      expect(yield* claimRoom(path, "den", GM_B)).toEqual({ holder: GM_A, claimed: false });
      expect(yield* claimRoom(path, "attic", GM_B)).toEqual({ holder: GM_B, claimed: true });
      expect(yield* readRooms(path)).toEqual({ den: GM_A, attic: GM_B });
      // Plain JSON a person can read, room to fingerprint, for the relay's owner alone.
      expect(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))).toEqual({
        attic: GM_B,
        den: GM_A,
      });
      expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(0o600);
    }),
  );

  effect("forget releases a claim, and the next host key claims it", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "rooms.json");
      yield* claimRoom(path, "den", GM_A);
      expect(yield* forgetRoom(path, "den")).toBe(GM_A);
      expect(yield* forgetRoom(path, "den")).toBeUndefined();
      expect(yield* claimRoom(path, "den", GM_B)).toEqual({ holder: GM_B, claimed: true });
    }),
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

  effect("the registry holds at most so many rooms; a claim past that is refused", () =>
    Effect.gen(function* () {
      const path = join(yield* tempDir, "rooms.json");
      expect(yield* claimRoom(path, "den", GM_A, { maxRooms: 2 })).toEqual({
        holder: GM_A,
        claimed: true,
      });
      expect(yield* claimRoom(path, "attic", GM_A, { maxRooms: 2 })).toMatchObject({
        claimed: true,
      });
      expect(yield* claimRoom(path, "cellar", GM_B, { maxRooms: 2 })).toEqual({ full: true });
      // A room already held is still answered.
      expect(yield* claimRoom(path, "den", GM_A, { maxRooms: 2 })).toEqual({
        holder: GM_A,
        claimed: false,
      });
      expect(Object.keys(yield* readRooms(path)).sort()).toEqual(["attic", "den"]);
    }),
  );

  effect("a damaged file is an error, never an empty registry that hands rooms out", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      for (const [name, text] of [
        ["garbage", "not json"],
        ["array", "[]"],
        ["bad-room", JSON.stringify({ "Bad Room": GM_A })],
        ["bad-key", JSON.stringify({ den: "ssh-ed25519 AAAA" })],
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
