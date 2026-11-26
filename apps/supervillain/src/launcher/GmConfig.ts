import {
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";

import { configDir } from "../host/GmKey.ts";

const GM_CONFIG_FILE = "gm.json";

export const GmConfigData = Schema.Struct({
	handle: Schema.optionalKey(Schema.String),
	relay: Schema.optionalKey(Schema.String),
});

export type GmConfigData = typeof GmConfigData.Type;

const GmConfigJson = Schema.fromJsonString(GmConfigData);

const decodeConfig = Schema.decodeUnknownEffect(GmConfigJson);

const encodeConfig = Schema.encodeEffect(GmConfigJson);

export class GmConfigError extends Schema.TaggedError<GmConfigError>()(
	"GmConfigError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	}
) {}

export class GmConfig extends Context.Service<
	GmConfig,
	{
		readonly path: string;
		readonly read: Effect.Effect<GmConfigData, GmConfigError>;
		readonly save: (config: GmConfigData) => Effect.Effect<void, GmConfigError>;
	}
>()("supervillain/launcher/GmConfig") {
	static readonly make = Effect.fn("GmConfig.make")(function* (dir?: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const folder = dir ?? (yield* configDir);
		const file = path.join(folder, GM_CONFIG_FILE);

		const failed = (what: string) => (cause: { readonly message: string }) =>
			new GmConfigError({
				message: `${what} ${file}: ${cause.message}`,
				cause,
			});

		const read = fs.readFileString(file).pipe(
			Effect.asSome,
			Effect.catchReason("PlatformError", "NotFound", () =>
				Effect.succeed(Option.none<string>())
			),
			Effect.mapError(failed("can't read")),
			Effect.flatMap((text) =>
				Option.match(text, {
					onNone: () => Effect.succeed<GmConfigData>({}),
					onSome: (json) =>
						decodeConfig(json).pipe(
							Effect.mapError(failed("can't understand"))
						),
				})
			),
			Effect.withSpan("GmConfig.read")
		);

		let saves = 0;

		const save = Effect.fn("GmConfig.save")(
			function* (config: GmConfigData) {
				const text = yield* encodeConfig(config);
				const now = yield* Clock.currentTimeMillis;
				saves += 1;
				const temporary = `${file}.${process.pid}.${now}.${saves}.tmp`;

				yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
				yield* fs
					.writeFileString(temporary, `${text}\n`, {
						mode: 0o600,
						flag: "wx",
					})
					.pipe(
						Effect.andThen(fs.chmod(temporary, 0o600)),
						Effect.andThen(fs.rename(temporary, file)),
						Effect.onError(() =>
							fs.remove(temporary, { force: true }).pipe(Effect.ignore)
						)
					);
			},
			Effect.mapError(failed("can't write"))
		);

		return GmConfig.of({ path: file, read, save });
	});

	static readonly layer = (
		dir?: string
	): Layer.Layer<GmConfig, never, FileSystem.FileSystem | Path.Path> =>
		Layer.effect(GmConfig, GmConfig.make(dir));
}
