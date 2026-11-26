import { isFingerprint } from "@supervillain/ssh";
import {
	Clock,
	DateTime,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
} from "effect";
import type { PlatformError } from "effect";

import { isHandle } from "./protocol.ts";

export class HandlesError extends Schema.TaggedError<HandlesError>()(
	"HandlesError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export interface HandleClaim {
	readonly keys: ReadonlyArray<string>;
	readonly claimed: number;
	readonly seen: number;
}

export type Handles = Readonly<Record<string, HandleClaim>>;

const StoredClaim = Schema.Struct({
	keys: Schema.Array(Schema.String),
	claimed: Schema.String,
	seen: Schema.String,
});

type StoredClaim = typeof StoredClaim.Type;

const decodeHandlesFile = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, StoredClaim))
);

export const HANDLE_POLICY = {
	maxHandles: 4096,
	maxKeysPerHandle: 4,
	claimDays: 180,
	unlinkedDays: 30,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

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
	(cause: PlatformError.PlatformError): HandlesError =>
		new HandlesError({ message: `${path}: ${cause.message}`, cause });

const damaged = (path: string, why: string) =>
	new HandlesError({ message: `${path}: ${why}` });

const millisAt = (iso: string): number | undefined =>
	Option.getOrUndefined(
		DateTime.make(iso).pipe(Option.map(DateTime.toEpochMillis))
	);

const claimOf = (
	path: string,
	handle: string,
	stored: StoredClaim
): Effect.Effect<HandleClaim, HandlesError> => {
	if (!isHandle(handle)) {
		return Effect.fail(damaged(path, `${handle} is not a handle`));
	}

	const bad = stored.keys.find((key) => !isFingerprint(key));

	if (bad !== undefined || stored.keys.length === 0) {
		return Effect.fail(
			damaged(
				path,
				`handle ${handle} holds ${bad ?? "no keys"}, not SHA256 fingerprints`
			)
		);
	}

	const claimed = millisAt(stored.claimed);
	const seen = millisAt(stored.seen);

	return claimed === undefined || seen === undefined
		? Effect.fail(
				damaged(path, `handle ${handle} has a time that isn't an ISO time`)
			)
		: Effect.succeed({ keys: stored.keys, claimed, seen });
};

const load = Effect.fn("handles.load")(function* (
	path: string
): Effect.fn.Return<Handles, HandlesError, FileSystem.FileSystem> {
	const fs = yield* FileSystem.FileSystem;

	const text = yield* fs.readFileString(path).pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () =>
			Effect.succeed(Option.none<string>())
		),
		Effect.mapError(failed(path))
	);

	if (Option.isNone(text)) {
		const none: Handles = {};

		return none;
	}

	const stored = yield* decodeHandlesFile(text.value).pipe(
		Effect.mapError(
			(cause) =>
				new HandlesError({
					message: `${path}: expected an object of handles to claims: ${cause.message}`,
					cause,
				})
		)
	);

	const claims = yield* Effect.forEach(
		Object.entries(stored),
		([handle, claim]) =>
			claimOf(path, handle, claim).pipe(
				Effect.map((held): readonly [string, HandleClaim] => [handle, held])
			),
		{ concurrency: 1 }
	);

	const handles: Handles = Object.fromEntries(claims);

	return handles;
});

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const fileText = (handles: Handles): string => {
	const sorted = Object.fromEntries(
		Object.entries(handles)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([handle, { keys, claimed, seen }]) => [
				handle,
				{ keys, claimed: iso(claimed), seen: iso(seen) },
			])
	);

	return `${JSON.stringify(sorted, null, 2)}\n`;
};

const save = Effect.fn("handles.save")(function* (
	path: string,
	handles: Handles
) {
	const fs = yield* FileSystem.FileSystem;
	const paths = yield* Path.Path;
	const now = yield* Clock.currentTimeMillis;
	saves += 1;
	const temporary = `${path}.${process.pid}.${now}.${saves}.tmp`;

	yield* fs
		.makeDirectory(paths.dirname(path), { recursive: true, mode: PRIVATE_DIR })
		.pipe(
			Effect.andThen(
				fs.writeFileString(temporary, fileText(handles), {
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
): Effect.Effect<void, HandlesError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const now = yield* Clock.currentTimeMillis;

		const age = yield* fs.stat(lock).pipe(
			Effect.map((info) => ageOf(info, now)),
			Effect.orElseSucceed(() => 0)
		);

		const stale = age > LOCK_STALE_MS;

		if (!stale && now - start > LOCK_WAIT_MS) {
			return yield* new HandlesError({
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
): Effect.Effect<void, HandlesError, FileSystem.FileSystem> =>
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
	change: Effect.Effect<A, HandlesError, R>
): Effect.Effect<A, HandlesError, R | FileSystem.FileSystem | Path.Path> =>
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

export const readHandles = (
	path: string
): Effect.Effect<Handles, HandlesError, FileSystem.FileSystem> => load(path);

export interface HandlePolicy {
	readonly maxHandles?: number;
	readonly maxKeysPerHandle?: number;
	readonly claimDays?: number;
	readonly unlinkedDays?: number;
	readonly linked?: ReadonlySet<string>;
}

export type HandleVerdict =
	| { readonly kind: "holds" }
	| { readonly kind: "held"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "free"; readonly drop: ReadonlyArray<string> }
	| { readonly kind: "full" };

export const everLinked = (claim: HandleClaim): boolean =>
	claim.seen > claim.claimed;

export const lapsedClaim = (
	handle: string,
	claim: HandleClaim,
	now: number,
	policy: HandlePolicy
): boolean => {
	if (policy.linked?.has(handle) === true) {
		return false;
	}

	const days = everLinked(claim)
		? (policy.claimDays ?? HANDLE_POLICY.claimDays)
		: (policy.unlinkedDays ?? HANDLE_POLICY.unlinkedDays);

	return now - claim.seen > days * DAY_MS;
};

export const judgeHandle = (
	handles: Handles,
	handle: string,
	fingerprint: string,
	now: number,
	policy: HandlePolicy = {}
): HandleVerdict => {
	const maxHandles = policy.maxHandles ?? HANDLE_POLICY.maxHandles;

	const lapsed = ([name, claim]: readonly [string, HandleClaim]) =>
		lapsedClaim(name, claim, now, policy);

	const holder = handles[handle];

	if (holder?.keys.includes(fingerprint) === true) {
		return { kind: "holds" };
	}

	if (holder !== undefined && !lapsed([handle, holder])) {
		return { kind: "held", keys: holder.keys };
	}

	const entries = Object.entries(handles);
	const drop = entries.filter((entry) => lapsed(entry)).map(([name]) => name);
	const left = entries.filter((entry) => !lapsed(entry));

	return left.length < maxHandles ? { kind: "free", drop } : { kind: "full" };
};

export interface Dropped extends HandleClaim {
	readonly handle: string;
}

export type Claim =
	| {
			readonly keys: ReadonlyArray<string>;
			readonly claimed: boolean;
			readonly dropped: ReadonlyArray<Dropped>;
	  }
	| { readonly full: true };

const droppedFrom = (
	handles: Handles,
	names: ReadonlyArray<string>
): ReadonlyArray<Dropped> =>
	names.flatMap((name) => {
		const claim = handles[name];

		return claim === undefined ? [] : [{ handle: name, ...claim }];
	});

const without = (handles: Handles, names: ReadonlyArray<string>): Handles => {
	const gone = new Set(names);

	return Object.fromEntries(
		Object.entries(handles).filter(([name]) => !gone.has(name))
	);
};

export const claimHandle = (
	path: string,
	handle: string,
	fingerprint: string,
	policy: HandlePolicy = {}
): Effect.Effect<Claim, HandlesError, FileSystem.FileSystem | Path.Path> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) =>
		locked(
			path,
			Effect.gen(function* () {
				const handles = yield* load(path);
				const verdict = judgeHandle(handles, handle, fingerprint, now, policy);

				if (verdict.kind === "full") {
					const full: Claim = { full: true };

					return full;
				}

				if (verdict.kind === "held") {
					const held: Claim = {
						keys: verdict.keys,
						claimed: false,
						dropped: [],
					};

					return held;
				}

				if (verdict.kind === "holds") {
					const holds: Claim = {
						keys: handles[handle]?.keys ?? [fingerprint],
						claimed: false,
						dropped: [],
					};

					return holds;
				}

				const dropped = droppedFrom(handles, verdict.drop);

				yield* save(path, {
					...without(handles, verdict.drop),
					[handle]: { keys: [fingerprint], claimed: now, seen: now },
				});

				const made: Claim = { keys: [fingerprint], claimed: true, dropped };

				return made;
			})
		)
	);

export type KeyAdded =
	| { readonly kind: "added"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "already"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "unclaimed" }
	| { readonly kind: "full"; readonly keys: ReadonlyArray<string> };

export const addKey = (
	path: string,
	handle: string,
	fingerprint: string,
	policy: HandlePolicy = {}
): Effect.Effect<KeyAdded, HandlesError, FileSystem.FileSystem | Path.Path> =>
	locked(
		path,
		Effect.gen(function* () {
			const handles = yield* load(path);
			const claim = handles[handle];

			if (claim === undefined) {
				const unclaimed: KeyAdded = { kind: "unclaimed" };

				return unclaimed;
			}

			if (claim.keys.includes(fingerprint)) {
				const already: KeyAdded = { kind: "already", keys: claim.keys };

				return already;
			}

			if (
				claim.keys.length >=
				(policy.maxKeysPerHandle ?? HANDLE_POLICY.maxKeysPerHandle)
			) {
				const full: KeyAdded = { kind: "full", keys: claim.keys };

				return full;
			}

			const keys = [...claim.keys, fingerprint];
			yield* save(path, { ...handles, [handle]: { ...claim, keys } });

			const added: KeyAdded = { kind: "added", keys };

			return added;
		})
	);

export const touchHandle = (
	path: string,
	handle: string,
	fingerprint: string
): Effect.Effect<void, HandlesError, FileSystem.FileSystem | Path.Path> =>
	Effect.flatMap(Clock.currentTimeMillis, (now) =>
		locked(
			path,
			Effect.gen(function* () {
				const handles = yield* load(path);
				const claim = handles[handle];

				if (claim?.keys.includes(fingerprint) === true) {
					yield* save(path, {
						...handles,
						[handle]: { ...claim, seen: Math.max(now, claim.claimed + 1) },
					});
				}
			})
		)
	);

export const forgetHandle = (
	path: string,
	handle: string
): Effect.Effect<
	ReadonlyArray<string> | undefined,
	HandlesError,
	FileSystem.FileSystem | Path.Path
> =>
	locked(
		path,
		Effect.gen(function* () {
			const handles = yield* load(path);
			const holder = Option.fromNullishOr(handles[handle]);

			if (Option.isSome(holder)) {
				yield* save(path, without(handles, [handle]));
			}

			return Option.getOrUndefined(Option.map(holder, (claim) => claim.keys));
		})
	);

export const retireLegacyRooms = (
	dir: string
): Effect.Effect<
	Option.Option<string>,
	HandlesError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* Path.Path;
		const legacy = paths.join(dir, "rooms.json");

		const there = yield* fs
			.exists(legacy)
			.pipe(Effect.mapError(failed(legacy)));

		if (!there) {
			return Option.none<string>();
		}

		const plain = `${legacy}.legacy`;

		const taken = yield* fs.exists(plain).pipe(Effect.mapError(failed(plain)));

		const now = yield* Clock.currentTimeMillis;

		const retired = taken
			? `${plain}.${DateTime.formatIso(DateTime.makeUnsafe(now)).replaceAll(":", "-")}`
			: plain;

		const clash = yield* fs
			.exists(retired)
			.pipe(Effect.mapError(failed(retired)));

		if (clash) {
			return yield* damaged(
				retired,
				"a retired rooms.json is already there; move it aside"
			);
		}

		yield* fs.rename(legacy, retired).pipe(Effect.mapError(failed(legacy)));

		return Option.some(retired);
	});

const writableBy = (mode: number, bit: number): boolean =>
	Math.floor((mode % PERMISSION_BITS) / bit) % 2 === 1;

export const checkRelayDir = (
	dir: string
): Effect.Effect<void, HandlesError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { mode } = yield* fs.stat(dir).pipe(Effect.mapError(failed(dir)));

		const shared =
			writableBy(mode, GROUP_WRITE) || writableBy(mode, OTHERS_WRITE);

		return yield* shared
			? Effect.fail(
					damaged(
						dir,
						`group or others can write to it (mode ${(mode % PERMISSION_BITS).toString(8)}), so anyone there could take its handles; chmod 700 ${dir}`
					)
				)
			: Effect.void;
	});
