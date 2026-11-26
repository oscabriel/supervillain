import { Effect, Option } from "effect";
import type { FileSystem, Path } from "effect";

export interface Files {
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
}

export type Bounded =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly problem: string };

const refused = (problem: string): Bounded => ({ ok: false, problem });

const kb = (bytes: number): number => Math.ceil(bytes / 1024);

export const tooLarge = (size: number, maxBytes: number): string =>
	`is ${kb(size)} KB; a campaign file holds at most ${kb(maxBytes)} KB`;

export const readBounded = Effect.fn("bounded.readBounded")(function* (
	fs: FileSystem.FileSystem,
	full: string,
	maxBytes: number
) {
	const info = yield* fs.stat(full).pipe(Effect.option);

	if (Option.isNone(info)) {
		return refused("can't be read");
	}

	if (info.value.type !== "File") {
		return refused("isn't a plain file");
	}

	const size = Number(info.value.size);

	if (size > maxBytes) {
		return refused(tooLarge(size, maxBytes));
	}

	const bytes = yield* fs.readFile(full).pipe(Effect.option);

	if (Option.isNone(bytes)) {
		return refused("can't be read");
	}

	return bytes.value.length > maxBytes
		? refused(tooLarge(bytes.value.length, maxBytes))
		: { ok: true as const, bytes: bytes.value };
});

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const utf8Of = (bytes: Uint8Array): string | undefined => {
	try {
		return UTF8.decode(bytes);
	} catch {
		return undefined;
	}
};
