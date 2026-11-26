import { Effect, FileSystem, Layer, PlatformError } from "effect";

export const diskTakes = (bytes: number, full: boolean) =>
	Layer.effect(
		FileSystem.FileSystem,
		Effect.gen(function* () {
			const real = yield* FileSystem.FileSystem;
			const disk = { short: false };

			const shorten = (file: FileSystem.File): FileSystem.File => ({
				[FileSystem.FileTypeId]: FileSystem.FileTypeId,
				stat: Effect.suspend(() => file.stat),
				seek: (offset, from) => file.seek(offset, from),
				sync: Effect.suspend(() => file.sync),
				read: (buffer, options) => file.read(buffer, options),
				readAlloc: (size, options) => file.readAlloc(size, options),
				truncate: (length) => file.truncate(length),
				writeAll: (buffer) => file.writeAll(buffer),
				write: (buffer) =>
					Effect.suspend(() => {
						if (full && disk.short) {
							return Effect.fail(
								PlatformError.badArgument({
									module: "FileSystem",
									method: "write",
									description: "no space left on device",
								})
							);
						}

						disk.short = buffer.length > bytes;

						return file.write(buffer.subarray(0, bytes));
					}),
			});

			return FileSystem.FileSystem.of({
				...real,
				open: (path, options) => Effect.map(real.open(path, options), shorten),
			});
		})
	);

export const sameDisk = Layer.effect(
	FileSystem.FileSystem,
	Effect.service(FileSystem.FileSystem)
);

export interface LockWatch {
	taken: boolean;
	gaps: number;
}

export const takenMeanwhile = (lock: string, rival: number, watch: LockWatch) =>
	Layer.effect(
		FileSystem.FileSystem,
		Effect.gen(function* () {
			const real = yield* FileSystem.FileSystem;

			const probe = Effect.gen(function* () {
				const there = yield* real.exists(lock);

				if (watch.taken && !there) {
					watch.gaps += 1;
				}
			}).pipe(Effect.ignore);

			const take = Effect.gen(function* () {
				yield* real.remove(lock);
				yield* real.writeFileString(lock, `${rival}\n`);
				watch.taken = true;
			});

			return FileSystem.FileSystem.of({
				...real,
				readFileString: (path, encoding) =>
					path === lock && !watch.taken
						? Effect.tap(real.readFileString(path, encoding), () => take)
						: real.readFileString(path, encoding),
				link: (from, to) => Effect.ensuring(real.link(from, to), probe),
				rename: (from, to) => Effect.ensuring(real.rename(from, to), probe),
				remove: (path, options) =>
					Effect.ensuring(real.remove(path, options), probe),
			});
		})
	);

export interface ReadCount {
	reads: number;
}

export const countingReads = (count: ReadCount) =>
	Layer.effect(
		FileSystem.FileSystem,
		Effect.gen(function* () {
			const real = yield* FileSystem.FileSystem;

			return FileSystem.FileSystem.of({
				...real,
				readFile: (path) =>
					Effect.suspend(() => {
						count.reads += 1;

						return real.readFile(path);
					}),
			});
		})
	);
