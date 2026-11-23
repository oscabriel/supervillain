import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import type { CliRendererErrorEvent } from "@opentui/core";
import { GM } from "@supervillain/domain";
import { Effect, FiberSet, Function, Latch } from "effect";

import { mountTable, openSeat } from "./Seat.ts";
import type { TableServices } from "./services.ts";
import type { View } from "./View.ts";

export interface LocalSeatOptions {
	readonly room: string;
	readonly helpFooter?: string;
	readonly joinHint?: string;
	readonly joinNote?: View<string>;
	readonly alert?: View<string | undefined>;
}

export const localSeat = (
	options: LocalSeatOptions
): Effect.Effect<void, never, TableServices> =>
	Effect.gen(function* () {
		const renderer = yield* Effect.acquireRelease(
			Effect.promise(
				async () =>
					await createCliRenderer({
						exitOnCtrlC: false,
						exitSignals: [],
						enableMouseMovement: false,
						autoFocus: false,
						openConsoleOnError: false,
					})
			),
			(r) =>
				Effect.promise(async () => {
					r.destroy();
					await r.closed.catch(Function.constVoid);
				})
		);

		const left = yield* Latch.make();

		const leave = () => {
			left.openUnsafe();
		};

		renderer.on(CliRenderEvents.DESTROY, leave);
		const fork = yield* FiberSet.makeRuntime();
		let failure = "";
		renderer.on(
			CliRenderEvents.RENDER_ERROR,
			({ error }: CliRendererErrorEvent) => {
				if (error.message === failure) {
					return;
				}

				failure = error.message;
				fork(Effect.logError(`seat ${GM}: a frame failed: ${failure}`));
			}
		);

		const view = yield* openSeat({ ...options, actor: GM, leave });

		yield* mountTable(renderer, view);
		yield* left.await;
	}).pipe(Effect.scoped);
