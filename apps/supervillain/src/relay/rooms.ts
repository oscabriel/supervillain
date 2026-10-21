// The relay's one durable fact: which GM host key holds each room. rooms.json maps room to the host
// key fingerprint that first linked it. It is read fresh at every use, so `supervillain relay forget`
// takes effect on a running relay; writes go to a temporary file and are renamed into place, under
// a lock file, so a `forget` from another process can't drop a claim the relay makes meanwhile.
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { isRoomName } from "./protocol.ts";

export class RoomsError extends Schema.TaggedError<RoomsError>()("RoomsError", {
  message: Schema.String,
}) {}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export type Rooms = Readonly<Record<string, string>>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const load = async (path: string): Promise<Record<string, string>> => {
  const text = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("expected an object of room names to host key fingerprints");
  const rooms: Record<string, string> = {};
  for (const [room, fingerprint] of Object.entries(parsed)) {
    if (!isRoomName(room)) throw new Error(`${JSON.stringify(room)} is not a room name`);
    if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint))
      throw new Error(
        `room ${room} holds ${JSON.stringify(fingerprint)}, not a SHA256 fingerprint`,
      );
    rooms[room] = fingerprint;
  }
  return rooms;
};

let saves = 0;

const save = async (path: string, rooms: Record<string, string>) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(Object.entries(rooms).sort(([a], [b]) => a.localeCompare(b)));
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
  attempt(path, () => load(path));

export type Claim =
  | { readonly holder: string; readonly claimed: boolean }
  /** The registry holds `maxRooms` already, and this room isn't one of them. */
  | { readonly full: true };

/**
 * Claims `room` for the host key `fingerprint` unless it's held. Returns who holds it after, and
 * whether this call claimed it; or, past `maxRooms` claims, that the registry is full.
 */
export const claimRoom = (
  path: string,
  room: string,
  fingerprint: string,
  options: { readonly maxRooms?: number } = {},
): Effect.Effect<Claim, RoomsError> =>
  attempt(path, () =>
    locked(path, async (): Promise<Claim> => {
      const rooms = await load(path);
      const holder = rooms[room];
      if (holder !== undefined) return { holder, claimed: false };
      if (options.maxRooms !== undefined && Object.keys(rooms).length >= options.maxRooms)
        return { full: true };
      rooms[room] = fingerprint;
      await save(path, rooms);
      return { holder: fingerprint, claimed: true };
    }),
  );

/** Releases `room`; returns the host key that held it, if one did. */
export const forgetRoom = (
  path: string,
  room: string,
): Effect.Effect<string | undefined, RoomsError> =>
  attempt(path, () =>
    locked(path, async () => {
      const rooms = await load(path);
      const holder = rooms[room];
      if (holder === undefined) return undefined;
      delete rooms[room];
      await save(path, rooms);
      return holder;
    }),
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
