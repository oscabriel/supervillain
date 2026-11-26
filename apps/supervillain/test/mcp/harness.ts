import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";

import { Context, Effect, Layer, Logger } from "effect";
import type { FileSystem, Path } from "effect";
import { McpTest } from "effect/ai";
import type { McpSchema } from "effect/ai";

import { runLine } from "../../src/host/line.ts";
import type { Reply } from "../../src/host/line.ts";
import { Presence } from "../../src/host/Presence.ts";
import { tableServices } from "../../src/host/services.ts";
import { TableRoom } from "../../src/host/TableRoom.ts";
import type { McpSeat } from "../../src/mcp/seat.ts";
import {
	MCP_PROTOCOLS,
	mcpSession,
	registrations,
} from "../../src/mcp/session.ts";
import { openCampaign, openSampleCampaign } from "../host/campaign.ts";
import { unreachable } from "../host/setWorld.ts";
import { lineRpc } from "./rpc.ts";

export const VEX = "key:SHA256:vexVEXvexVEXvexVEXvexVEXvexVEXvexVEXvexVEXv";

export const WREN = "key:SHA256:wrenWRENwrenWRENwrenWRENwrenWRENwrenWRENwre";

export const gmSeat: McpSeat = {
	actor: "gm",
	role: "gm",
	rateKey: "gm",
	room: "den",
};

export const playerSeat = (actor: string): McpSeat => ({
	actor,
	role: "player",
	rateKey: actor,
	room: "den",
});

export const RULES = ["draw-steel", "set-world", "pf2e", "freeform"] as const;

export const rulesCampaign = (rules: (typeof RULES)[number]) =>
	Effect.gen(function* () {
		if (rules === "draw-steel") {
			return yield* openSampleCampaign;
		}

		const dir = yield* openCampaign;

		yield* Effect.promise(async () => {
			await writeFile(path.join(dir, "campaign.yaml"), `rules: ${rules}\n`);
		});

		return dir;
	});

export const appendTo = (dir: string, file: string, text: string) =>
	Effect.promise(async () => {
		await appendFile(path.join(dir, file), text);
	});

export const mcpTable = (dir: string) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			Layer.mergeAll(
				tableServices(dir, { setWorld: unreachable, watchContent: false }),
				Logger.layer([])
			).pipe(Layer.provide(Logger.layer([])))
		);

		const line = (actor: string, typed: string): Effect.Effect<Reply> =>
			Effect.provideContext(runLine(actor, typed), context);

		const state = () => Context.get(context, TableRoom).state;

		const client = (seat: McpSeat) =>
			McpTest.makeClient(
				registrations(seat).pipe(Layer.provide(Layer.succeedContext(context))),
				{ protocols: MCP_PROTOCOLS }
			);

		const presence = Context.get(context, Presence);

		const full = Context.merge(
			yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
			context
		);

		const session = (seat: McpSeat) =>
			Effect.gen(function* () {
				const toServer = new PassThrough();
				const fromServer = new PassThrough();
				const stderr = new PassThrough();

				const stream = Duplex.fromWeb({
					readable: Readable.toWeb(toServer),
					writable: Writable.toWeb(fromServer),
				});

				const closed = Promise.withResolvers<number>();
				let errors = "";

				stderr.on("data", (chunk: Buffer) => {
					errors += chunk.toString();
				});

				const rpc = lineRpc((text) => {
					toServer.write(text);
				});

				fromServer.on("data", rpc.feed);

				const fiber = yield* Effect.forkChild(
					mcpSession({
						...seat,
						stream,
						stderr,
						close: (code) => {
							closed.resolve(code);
							toServer.end();
						},
					}).pipe(Effect.scoped, Effect.provideContext(full))
				);

				return {
					rpc,
					fiber,
					errors: () => errors,
					closed: closed.promise,
					end: () => {
						toServer.end();
					},
				};
			});

		return { context, full, line, state, client, presence, session };
	});

export const textOf = (result: McpSchema.CallToolResult): string =>
	result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");

export const readText = (result: McpSchema.ReadResourceResult): string =>
	result.contents
		.map((content) => ("text" in content ? content.text : ""))
		.join("\n");
