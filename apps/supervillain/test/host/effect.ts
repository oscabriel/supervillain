import { test } from "bun:test";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import type { FileSystem, Path, Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";

export const platform = Layer.mergeAll(
	BunServices.layer,
	FetchHttpClient.layer,
	SecureRandom.layerWebCrypto
);

export type Platform =
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom
	| Scope.Scope;

export const effect = <A, E>(
	name: string,
	body: () => Effect.Effect<A, E, Platform>,
	timeout?: number
) => {
	test(
		name,
		async () => {
			await Effect.runPromise(
				Effect.scoped(Effect.suspend(body)).pipe(Effect.provide(platform))
			);
		},
		timeout
	);
};

export const must = <A>(value: A | undefined, why: string): A => {
	if (value === undefined) {
		throw new Error(why);
	}

	return value;
};

const poll = async (
	what: string,
	predicate: () => boolean,
	deadline: number
): Promise<void> => {
	if (predicate()) {
		return;
	}

	if (performance.now() > deadline) {
		throw new Error(`timed out waiting for ${what}`);
	}

	await Bun.sleep(10);
	await poll(what, predicate, deadline);
};

export const waitFor = (what: string, predicate: () => boolean, ms = 3000) =>
	Effect.promise(async () => {
		await poll(what, predicate, performance.now() + ms);
	});
