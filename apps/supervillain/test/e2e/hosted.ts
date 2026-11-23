import { plainText } from "@supervillain/domain";
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect";

import { runLine } from "../../src/host/line.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { TableRoomOptions } from "../../src/host/TableRoom.ts";
import { TableServer } from "../../src/host/TableServer.ts";
import { sshExec } from "./openssh.ts";
import type { ClientKey } from "./openssh.ts";

export const hostTable = (dir: string, options: TableRoomOptions = {}) =>
	Effect.gen(function* () {
		const scope = yield* Scope.fork(yield* Scope.Scope);

		const layer = TableServer.layer({
			campaignDir: dir,
			room: "ford",
			port: 0,
			bind: "127.0.0.1",
		}).pipe(
			Layer.provideMerge(tableServices(dir, options)),
			Layer.provide(Logger.layer([]))
		);

		const context = yield* Layer.buildWithScope(layer, scope);

		const gm = (line: string) =>
			runLine("gm", line).pipe(Effect.provideContext(context));

		const { state } = Context.get(context, TableRoom);

		return {
			port: Context.get(context, TableServer).port,
			gm,
			state,
			stop: Scope.close(scope, Exit.void),
		};
	});

export type Hosted = Effect.Success<ReturnType<typeof hostTable>>;

export const asGm = (table: Hosted, line: string) =>
	Effect.gen(function* () {
		const reply = yield* table.gm(line);

		if (reply.kind !== "done") {
			throw new Error(
				`the GM's ${line} came back ${"text" in reply ? reply.text : reply.kind}`
			);
		}

		return reply.lines.map(plainText);
	});

export const asPlayer = (port: number, key: ClientKey, line: string) =>
	Effect.gen(function* () {
		const result = yield* sshExec(port, line, key);

		if (result.exitCode !== 0) {
			throw new Error(`${line} failed: ${result.stderr}`);
		}

		return result.stdout;
	});

export { logOf } from "./log.ts";
