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
