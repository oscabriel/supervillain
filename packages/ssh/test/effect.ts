import { test } from "bun:test";

import { Effect } from "effect";
import type { Scope } from "effect";

export const effect = <E>(
	name: string,
	body: () => Effect.Effect<unknown, E, Scope.Scope>,
	timeout?: number
) => {
	test(
		name,
		async () => {
			await Effect.runPromise(Effect.scoped(Effect.suspend(body)));
		},
		timeout
	);
};

effect.skipIf =
	(skip: boolean) =>
	<E>(
		name: string,
		body: () => Effect.Effect<unknown, E, Scope.Scope>,
		timeout?: number
	) => {
		test.skipIf(skip)(
			name,
			async () => {
				await Effect.runPromise(Effect.scoped(Effect.suspend(body)));
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
