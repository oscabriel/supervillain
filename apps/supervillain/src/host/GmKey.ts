import { homedir } from "node:os";

import { loadHostKey } from "@supervillain/ssh";
import { Config, Context, Effect, Layer, Option, Path, Schema } from "effect";

const GM_KEY_FILE = "gm_key";

export class GmKeyError extends Schema.TaggedError<GmKeyError>()("GmKeyError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const configDir = Effect.gen(function* () {
	const path = yield* Path.Path;

	const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME")).pipe(
		Effect.orElseSucceed(() => Option.none<string>())
	);

	return Option.match(xdg, {
		onNone: () => path.join(homedir(), ".config", "supervillain"),
		onSome: (base) =>
			base === ""
				? path.join(homedir(), ".config", "supervillain")
				: path.join(base, "supervillain"),
	});
}).pipe(Effect.withSpan("GmKey.configDir"));

export class GmKey extends Context.Service<
	GmKey,
	{
		readonly path: string;
		readonly pem: Buffer;
		readonly fingerprint: string;
	}
>()("supervillain/host/GmKey") {
	static readonly make = Effect.fn("GmKey.make")(function* (dir?: string) {
		const path = yield* Path.Path;
		const folder = dir ?? (yield* configDir);
		const keyPath = path.join(folder, GM_KEY_FILE);

		const key = yield* Effect.tryPromise({
			try: async () => await loadHostKey(keyPath),
			catch: (cause) =>
				new GmKeyError({
					message: `your GM key at ${keyPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				}),
		});

		return GmKey.of({
			path: keyPath,
			pem: key.pem,
			fingerprint: key.fingerprint,
		});
	});

	static readonly layer = (
		dir?: string
	): Layer.Layer<GmKey, GmKeyError, Path.Path> =>
		Layer.effect(GmKey, GmKey.make(dir));
}
