// The relay's one durable fact: which GM host key holds each room, and when a GM last linked it.
// rooms.json maps each room to `{ key, linked }`: the fingerprint that claimed it and an ISO time
// by the relay's clock. A claim no GM has linked for the expiry lapses, and a full registry makes
// way by dropping its stalest claim with no GM linked now. The file is read fresh at every use, so
// `supervillain relay forget` takes effect on a running relay; writes go to a temporary file and
// are renamed into place, under a lock file, so a `forget` from another process can't drop a claim
// the relay makes meanwhile.
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isFingerprint } from "@supervillain/ssh";
import { Clock, Effect, Schema } from "effect";
import { isRoomName } from "./protocol.ts";

export class RoomsError extends Schema.TaggedError<RoomsError>()("RoomsError", {
  message: Schema.String,
}) {}

interface RoomClaim {
  /** The GM host key that holds the room. */
  readonly key: string;
  /** When a GM was last linked to it, by the relay's clock, in milliseconds since the epoch. */
  readonly linked: number;
}

export type Rooms = Readonly<Record<string, RoomClaim>>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Reads the registry. A claim written before claims had times (a bare fingerprint) reads as linked
 * `now`, so its clock starts with the first write.
 */
const load = async (path: string, now: number): Promise<Record<string, RoomClaim>> => {
  const text = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("expected an object of room names to claims");
  const rooms: Record<string, RoomClaim> = {};
  for (const [room, value] of Object.entries(parsed)) {
    if (!isRoomName(room)) throw new Error(`${JSON.stringify(room)} is not a room name`);
    const claim: unknown = typeof value === "string" ? { key: value, linked: now } : value;
    const { key, linked } = (typeof claim === "object" && claim !== null ? claim : {}) as {
      key?: unknown;
      linked?: unknown;
    };
    if (typeof key !== "string" || !isFingerprint(key))
      throw new Error(`room ${room} holds ${JSON.stringify(value)}, not a SHA256 fingerprint`);
    const at = typeof linked === "string" ? Date.parse(linked) : linked;
    if (typeof at !== "number" || !Number.isFinite(at))
      throw new Error(`room ${room} was last linked ${JSON.stringify(linked)}, not an ISO time`);
    rooms[room] = { key, linked: at };
  }
  return rooms;
};

let saves = 0;

const save = async (path: string, rooms: Record<string, RoomClaim>) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(
    Object.entries(rooms)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([room, { key, linked }]) => [room, { key, linked: new Date(linked).toISOString() }]),
  );
  const temporary = `${path}.${process.pid}.${Date.now()}.${saves++}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

/** How long a change waits for another's lock before giving up. */
const LOCK_WAIT_MS = 5000;
/** A lock older than this was left by a process that died holding it. A change takes milliseconds. */
const LOCK_STALE_MS = 10_000;

/** Runs `change` holding `<path>.lock`, made with O_EXCL, so changes from any process take turns. */
const locked = async <A>(path: string, change: () => Promise<A>): Promise<A> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const start = Date.now();
  for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await unlink(lock).catch(() => undefined);
      else if (Date.now() - start > LOCK_WAIT_MS)
        throw new Error(`${lock} has been held for over ${LOCK_WAIT_MS / 1000} s`, { cause: e });
      else await Bun.sleep(wait);
    }
  }
  try {
    return await change();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
};

const attempt = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (e) => new RoomsError({ message: `${path}: ${messageOf(e)}` }),
  });

/** Every claim. A file that's missing is no claims; one that's damaged is an error. */
export const readRooms = (path: string): Effect.Effect<Rooms, RoomsError> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => attempt(path, () => load(path, now)));

export interface ClaimPolicy {
  /** Claims the registry may hold. A claim past it makes way, or is refused. */
  readonly maxRooms?: number;
  /** A claim no GM has linked for longer than this lapses. */
  readonly expireMs?: number;
  /** Rooms with a GM linked now: their claims never lapse or make way. */
  readonly linked?: ReadonlySet<string>;
}

/** What a claim on a room would do now. */
type Verdict =
  /** The key holds the room already. */
  | { readonly kind: "holds" }
  /** Another key holds it. */
  | { readonly kind: "held"; readonly holder: string }
  /** The key may claim it, once these rooms' claims are dropped: lapsed, or making way. */
  | { readonly kind: "free"; readonly drop: ReadonlyArray<string> }
  /** The registry is full, and every claim in it has a GM linked now. */
  | { readonly kind: "full" };

/** Judges a claim on `room` by `fingerprint` at `now`, without writing anything. */
export const judgeClaim = (
  rooms: Rooms,
  room: string,
  fingerprint: string,
  now: number,
  policy: ClaimPolicy,
): Verdict => {
  const linked = (name: string) => policy.linked?.has(name) === true;
  const lapsed = (name: string) =>
    policy.expireMs !== undefined && !linked(name) && now - rooms[name]!.linked > policy.expireMs;
  const holder = rooms[room];
  if (holder?.key === fingerprint) return { kind: "holds" };
  if (holder !== undefined && !lapsed(room)) return { kind: "held", holder: holder.key };
  const drop = Object.keys(rooms).filter(lapsed);
  const left = Object.keys(rooms).filter((name) => !lapsed(name));
  if (policy.maxRooms !== undefined && left.length >= policy.maxRooms) {
    const stalest = left
      .filter((name) => !linked(name))
      .sort((a, b) => rooms[a]!.linked - rooms[b]!.linked)
      .slice(0, left.length - policy.maxRooms + 1);
    if (left.length - stalest.length >= policy.maxRooms) return { kind: "full" };
    drop.push(...stalest);
  }
  return { kind: "free", drop };
};

/** A claim dropped to make a new one: it lapsed, or it was the stalest in a full registry. */
interface Dropped extends RoomClaim {
  readonly room: string;
}

type Claim =
  | {
      readonly holder: string;
      readonly claimed: boolean;
      /** Claims dropped to make this one. */
      readonly dropped: ReadonlyArray<Dropped>;
    }
  /** The registry is full, and every claim in it has a GM linked now. */
  | { readonly full: true };

/**
 * Claims `room` for the host key `fingerprint` unless another holds it, as `judgeClaim` says, and
 * marks it linked now; the key that holds it already renews its time. Returns who holds it after,
 * whether this call claimed it and what claims it dropped; or that the registry is full.
 */
export const claimRoom = (
  path: string,
  room: string,
  fingerprint: string,
  policy: ClaimPolicy = {},
): Effect.Effect<Claim, RoomsError> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    attempt(path, () =>
      locked(path, async (): Promise<Claim> => {
        const rooms = await load(path, now);
        const verdict = judgeClaim(rooms, room, fingerprint, now, policy);
        if (verdict.kind === "full") return { full: true };
        if (verdict.kind === "held") return { holder: verdict.holder, claimed: false, dropped: [] };
        const dropped =
          verdict.kind === "free"
            ? verdict.drop.map((name) => ({ room: name, ...rooms[name]! }))
            : [];
        for (const { room: name } of dropped) delete rooms[name];
        rooms[room] = { key: fingerprint, linked: now };
        await save(path, rooms);
        return { holder: fingerprint, claimed: verdict.kind === "free", dropped };
      }),
    ),
  );

/** Marks `room` linked now, if `fingerprint` still holds it: as when that GM's link ends. */
export const touchRoom = (
  path: string,
  room: string,
  fingerprint: string,
): Effect.Effect<void, RoomsError> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    attempt(path, () =>
      locked(path, async () => {
        const rooms = await load(path, now);
        if (rooms[room]?.key !== fingerprint) return;
        rooms[room] = { key: fingerprint, linked: now };
        await save(path, rooms);
      }),
    ),
  );

/** Releases `room`; returns the host key that held it, if one did. */
export const forgetRoom = (
  path: string,
  room: string,
): Effect.Effect<string | undefined, RoomsError> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    attempt(path, () =>
      locked(path, async () => {
        const rooms = await load(path, now);
        const holder = rooms[room];
        if (holder === undefined) return undefined;
        delete rooms[room];
        await save(path, rooms);
        return holder.key;
      }),
    ),
  );

/**
 * Refuses a relay folder that group or others can write to: whoever can swap rooms.json there can
 * take any room. The keys in it are checked on their own when they're loaded.
 */
export const checkRelayDir = (dir: string): Effect.Effect<void, RoomsError> =>
  attempt(dir, async () => {
    const mode = (await stat(dir)).mode & 0o777;
    if ((mode & 0o022) !== 0)
      throw new Error(
        `group or others can write to it (mode ${mode.toString(8)}), so anyone there could take its rooms; chmod 700 ${dir}`,
      );
  });
