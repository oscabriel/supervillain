import { describe, expect } from "bun:test";
import { chmod, stat } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { serve } from "../src/index.ts";
import { effect } from "./effect.ts";
import { keygenFingerprint } from "./openssh.ts";
import { tempDir } from "./tempDir.ts";

const fingerprintOf = (hostKeyPath: string) =>
	Effect.scoped(
		serve({
			hostKeyPath,
			port: 0,
			host: "127.0.0.1",
			onShell: () => Effect.void,
		}).pipe(Effect.map((server) => server.hostKeyFingerprint))
	);

describe("host key", () => {
	effect(
		"is created as an owner-only ed25519 key on first serve, and reused after",
		() =>
			Effect.gen(function* () {
				const keyPath = path.join(yield* tempDir, "campaign", "host_key");
				const first = yield* fingerprintOf(keyPath);

				const { mode } = yield* Effect.promise(async () => await stat(keyPath));

				expect(mode % 0o1000).toBe(0o600);
				expect(first).toBe(yield* keygenFingerprint(keyPath));
				expect(yield* fingerprintOf(keyPath)).toBe(first);
			})
	);

	effect("is refused when other users can read it, as sshd refuses one", () =>
		Effect.gen(function* () {
			const keyPath = path.join(yield* tempDir, "host_key");
			yield* fingerprintOf(keyPath);
			yield* Effect.promise(async () => {
				await chmod(keyPath, 0o644);
			});
			const error = yield* Effect.flip(fingerprintOf(keyPath));
			expect(error.message).toContain("chmod 600");
		})
	);
});
