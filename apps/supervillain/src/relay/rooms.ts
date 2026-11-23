import { isFingerprint } from "@supervillain/ssh";
import {
	Clock,
	DateTime,
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Schema,
} from "effect";
import type { PlatformError } from "effect";

import { isRoomName } from "./protocol.ts";

export class RoomsError extends Schema.TaggedError<RoomsError>()("RoomsError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

interface RoomClaim {
	readonly key: string;
	readonly linked: number;
}

export type Rooms = Readonly<Record<string, RoomClaim>>;

const StoredClaim = Schema.Union([
	Schema.String,
	Schema.Struct({
		key: Schema.String,
		linked: Schema.Union([Schema.String, Schema.Finite]),
	}),
]);

type StoredClaim = typeof StoredClaim.Type;

const decodeRoomsFile = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, StoredClaim))
);

const LOCK_WAIT_MS = 5000;

const LOCK_STALE_MS = 10_000;

const LOCK_FIRST_WAIT_MS = 2;

const LOCK_LONGEST_WAIT_MS = 50;

const PRIVATE_DIR = 0o700;

const PRIVATE_FILE = 0o600;

const PERMISSION_BITS = 0o1000;

const GROUP_WRITE = 0o20;

const OTHERS_WRITE = 0o2;

let saves = 0;

const failed =
	(path: string) =>
	(cause: PlatformError.PlatformError): RoomsError =>
		new RoomsError({ message: `${path}: ${cause.message}`, cause });

const damaged = (path: string, why: string) =>
	new RoomsError({ message: `${path}: ${why}` });

const linkedAt = (linked: string | number): number | undefined =>
	Option.getOrUndefined(
		DateTime.make(linked).pipe(Option.map(DateTime.toEpochMillis))
	);

const claimOf = (
	path: string,
	room: string,
	stored: StoredClaim,
	now: number
): Effect.Effect<RoomClaim, RoomsError> => {
	if (!isRoomName(room)) {
		return Effect.fail(damaged(path, `${room} is not a room name`));
	}

	const { key, linked } = Predicate.isString(stored)
		? { key: stored, linked: now }
		: stored;

	if (!isFingerprint(key)) {
		return Effect.fail(
			damaged(path, `room ${room} holds ${key}, not a SHA256 fingerprint`)
		);
	}

	const at = linkedAt(linked);

	return at === undefined
		? Effect.fail(
				damaged(path, `room ${room} was last linked ${linked}, not an ISO time`)
			)
		: Effect.succeed({ key, linked: at });
};

const load = Effect.fn("rooms.load")(function* (
	path: string,
	now: number
): Effect.fn.Return<Rooms, RoomsError, FileSystem.FileSystem> {
	const fs = yield* FileSystem.FileSystem;

	const text = yield* fs.readFileString(path).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			Effect.succeed(Option.none<string>())
		),
		Effect.mapError(failed(path))
	);

	if (Option.isNone(text)) {
		const none: Rooms = {};

		return none;
	}

	const stored = yield* decodeRoomsFile(text.value).pipe(
		Effect.mapError(
			(cause) =>
				new RoomsError({
					message: `${path}: expected an object of room names to claims: ${cause.message}`,
					cause,
				})
		)
	);

	const claims = yield* Effect.forEach(
		Object.entries(stored),
		([room, claim]) =>
			claimOf(path, room, claim, now).pipe(
				Effect.map((held): readonly [string, RoomClaim] => [room, held])
			),
		{ concurrency: 1 }
	);

	const rooms: Rooms = Object.fromEntries(claims);

	return rooms;
});

const fileText = (rooms: Rooms): string => {
	const sorted = Object.fromEntries(
		Object.entries(rooms)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([room, { key, linked }]) => [
				room,
				{ key, linked: DateTime.formatIso(DateTime.makeUnsafe(linked)) },
			])
	);

	return `${JSON.stringify(sorted, null, 2)}\n`;
};

const save = Effect.fn("rooms.save")(function* (path: string, rooms: Rooms) {
	const fs = yield* FileSystem.FileSystem;
	const paths = yield* Path.Path;
	const now = yield* Clock.currentTimeMillis;
	saves += 1;
	const temporary = `${path}.${process.pid}.${now}.${saves}.tmp`;

	yield* fs
		.makeDirectory(paths.dirname(path), { recursive: true, mode: PRIVATE_DIR })
		.pipe(
			Effect.andThen(
				fs.writeFileString(temporary, fileText(rooms), {
					mode: PRIVATE_FILE,
					flag: "wx",
				})
			),
			Effect.andThen(fs.chmod(temporary, PRIVATE_FILE)),
			Effect.andThen(fs.rename(temporary, path)),
			Effect.mapError(failed(path))
		);
});

const ageOf = (info: FileSystem.File.Info, now: number): number =>
	Option.match(info.mtime, {
		onNone: () => 0,
		onSome: (mtime) => now - mtime.getTime(),
	});

const contend = (
	lock: string,
	start: number,
	wait: number
): Effect.Effect<void, RoomsError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const now = yield* Clock.currentTimeMillis;

		const age = yield* fs.stat(lock).pipe(
			Effect.map((info) => ageOf(info, now)),
			Effect.orElseSucceed(() => 0)
		);

		const stale = age > LOCK_STALE_MS;

		if (!stale && now - start > LOCK_WAIT_MS) {
			return yield* new RoomsError({
				message: `${lock} has been held for over ${LOCK_WAIT_MS / 1000} s`,
			});
		}

		yield* stale ? fs.remove(lock).pipe(Effect.ignore) : Effect.sleep(wait);

		return yield* takeLock(
			lock,
			start,
			Math.min(wait * 2, LOCK_LONGEST_WAIT_MS)
		);
	});

const takeLock = (
	lock: string,
	start: number,
	wait: number
): Effect.Effect<void, RoomsError, FileSystem.FileSystem> =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.open(lock, { flag: "wx", mode: PRIVATE_FILE }).pipe(
			Effect.scoped,
			Effect.as(true),
			Effect.catchReason("PlatformError", "AlreadyExists", () =>
				Effect.succeed(false)
			),
			Effect.mapError(failed(lock)),
			Effect.flatMap((taken) =>
				taken ? Effect.void : contend(lock, start, wait)
			)
		)
	);

const locked = <A, R>(
	path: string,
	change: Effect.Effect<A, RoomsError, R>
): Effect.Effect<A, RoomsError, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* Path.Path;
		const lock = `${path}.lock`;

		yield* fs
			.makeDirectory(paths.dirname(path), {
				recursive: true,
				mode: PRIVATE_DIR,
			})
			.pipe(Effect.mapError(failed(path)));

		const start = yield* Clock.currentTimeMillis;

		return yield* Effect.acquireUseRelease(
			takeLock(lock, start, LOCK_FIRST_WAIT_MS),
			() => change,
			() => fs.remove(lock).pipe(Effect.ignore)
		);
	});

export const readRooms = (
	path: string
): Effect.Effect<Rooms, RoomsError, FileSystem.FileSystem> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) => load(path, now));

export interface ClaimPolicy {
	readonly maxRooms?: number;
	readonly expireMs?: number;
	readonly linked?: ReadonlySet<string>;
}

type Verdict =
	| { readonly kind: "holds" }
	| { readonly kind: "held"; readonly holder: string }
	| { readonly kind: "free"; readonly drop: ReadonlyArray<string> }
	| { readonly kind: "full" };

export const judgeClaim = (
	rooms: Rooms,
	room: string,
	fingerprint: string,
	now: number,
	policy: ClaimPolicy
): Verdict => {
	const linked = (name: string) => policy.linked?.has(name) === true;

	const lapsed = ([name, claim]: readonly [string, RoomClaim]) =>
		policy.expireMs !== undefined &&
		!linked(name) &&
		now - claim.linked > policy.expireMs;

	const holder = rooms[room];

	if (holder?.key === fingerprint) {
		return { kind: "holds" };
	}

	if (holder !== undefined && !lapsed([room, holder])) {
		return { kind: "held", holder: holder.key };
	}

	const entries = Object.entries(rooms);
	const drop = entries.filter((entry) => lapsed(entry)).map(([name]) => name);
	const left = entries.filter((entry) => !lapsed(entry));

	if (policy.maxRooms === undefined || left.length < policy.maxRooms) {
		return { kind: "free", drop };
	}

	const stalest = left
		.filter(([name]) => !linked(name))
		.toSorted(([, a], [, b]) => a.linked - b.linked)
		.slice(0, left.length - policy.maxRooms + 1)
		.map(([name]) => name);

	if (left.length - stalest.length >= policy.maxRooms) {
		return { kind: "full" };
	}

	return { kind: "free", drop: [...drop, ...stalest] };
};

interface Dropped extends RoomClaim {
	readonly room: string;
}

export type Claim =
	| {
			readonly holder: string;
			readonly claimed: boolean;
			readonly dropped: ReadonlyArray<Dropped>;
	  }
	| { readonly full: true };

const droppedFrom = (
	rooms: Rooms,
	names: ReadonlyArray<string>
): ReadonlyArray<Dropped> =>
	names.flatMap((name) => {
		const claim = rooms[name];

		return claim === undefined ? [] : [{ room: name, ...claim }];
	});

const without = (rooms: Rooms, names: ReadonlyArray<string>): Rooms => {
	const gone = new Set(names);

	return Object.fromEntries(
		Object.entries(rooms).filter(([name]) => !gone.has(name))
	);
};

export const claimRoom = (
	path: string,
	room: string,
	fingerprint: string,
	policy: ClaimPolicy = {}
): Effect.Effect<Claim, RoomsError, FileSystem.FileSystem | Path.Path> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) =>
		locked(
			path,
			Effect.gen(function* () {
				const rooms = yield* load(path, now);
				const verdict = judgeClaim(rooms, room, fingerprint, now, policy);

				if (verdict.kind === "full") {
					const full: Claim = { full: true };

					return full;
				}

				if (verdict.kind === "held") {
					const held: Claim = {
						holder: verdict.holder,
						claimed: false,
						dropped: [],
					};

					return held;
				}

				const names = verdict.kind === "free" ? verdict.drop : [];
				const dropped = droppedFrom(rooms, names);

				yield* save(path, {
					...without(rooms, names),
					[room]: { key: fingerprint, linked: now },
				});

				const made: Claim = {
					holder: fingerprint,
					claimed: verdict.kind === "free",
					dropped,
				};

				return made;
			})
		)
	);

export const touchRoom = (
	path: string,
	room: string,
	fingerprint: string
): Effect.Effect<void, RoomsError, FileSystem.FileSystem | Path.Path> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) =>
		locked(
			path,
			Effect.gen(function* () {
				const rooms = yield* load(path, now);

				if (rooms[room]?.key === fingerprint) {
					yield* save(path, {
						...rooms,
						[room]: { key: fingerprint, linked: now },
					});
				}
			})
		)
	);

export const forgetRoom = (
	path: string,
	room: string
): Effect.Effect<
	string | undefined,
	RoomsError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) =>
		locked(
			path,
			Effect.gen(function* () {
				const rooms = yield* load(path, now);
				const holder = Option.fromNullishOr(rooms[room]);

				if (Option.isSome(holder)) {
					yield* save(path, without(rooms, [room]));
				}

				return Option.getOrUndefined(Option.map(holder, (claim) => claim.key));
			})
		)
	);

const writableBy = (mode: number, bit: number): boolean =>
	Math.floor((mode % PERMISSION_BITS) / bit) % 2 === 1;

export const checkRelayDir = (
	dir: string
): Effect.Effect<void, RoomsError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { mode } = yield* fs.stat(dir).pipe(Effect.mapError(failed(dir)));

		const shared =
			writableBy(mode, GROUP_WRITE) || writableBy(mode, OTHERS_WRITE);

		return yield* shared
			? Effect.fail(
					damaged(
						dir,
						`group or others can write to it (mode ${(mode % PERMISSION_BITS).toString(8)}), so anyone there could take its rooms; chmod 700 ${dir}`
					)
				)
			: Effect.void;
	});
