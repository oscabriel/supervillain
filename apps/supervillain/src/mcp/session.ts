import type { Duplex, Writable } from "node:stream";

import { GM, isMember, KNOCK_FIRST } from "@supervillain/domain";
import { Cause, Config, Effect, Fiber, Layer, Stdio, Stream } from "effect";
import type { Scope } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { CampaignContent } from "../content/index.ts";
import { Presence } from "../host/Presence.ts";
import { TableRoom } from "../host/TableRoom.ts";
import { gateOf } from "./limits.ts";
import { registerResources } from "./resources.ts";
import { AGENT_NEEDS_KEY, AGENT_SERVER } from "./seat.ts";
import type { McpSeat, McpServices } from "./seat.ts";
import { duplexStdio } from "./stdio.ts";
import { registerTools } from "./tools.ts";

export const MCP_PROTOCOLS = [
	McpProtocol.v2025_11_25,
	McpProtocol.v2025_06_18,
	McpProtocol.v2025_03_26,
	McpProtocol.v2024_11_05,
] as const;

export interface McpSessionOptions extends McpSeat {
	readonly stream: Duplex;
	readonly stderr?: Writable;
	readonly close: (code: number) => void;
}

const VERSION = Config.String("SUPERVILLAIN_VERSION").pipe(
	Config.withDefault("0.0.0")
);

export const instructionsOf = (seat: McpSeat, ruleset: string): string =>
	[
		`You are seated at the supervillain table "${seat.room}", which plays ${ruleset}, as ${seat.role === "gm" ? "its GM" : "a player"}.`,
		"Read get_table_state (or supervillain://table/state) first, then act with the cmd_ tools, or send_line to type a line as a person at the table would.",
		"Use wait_for_change with the seq you last saw to follow the table as it moves.",
		"A refused command comes back as an error result saying why; nothing changed at the table.",
	].join(" ");

export const registrations = (seat: McpSeat) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const gate = yield* gateOf(seat);

			yield* registerTools(seat, gate);
			yield* registerResources(seat, gate);
		})
	);

export const serverLayer = (seat: McpSeat, stdio: Stdio.Stdio) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { ruleset } = yield* CampaignContent;

			return McpServer.layerStdio({
				name: AGENT_SERVER,
				version: yield* VERSION,
				instructions: instructionsOf(seat, ruleset),
				protocols: MCP_PROTOCOLS,
				registrations: registrations(seat),
			});
		})
	).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, stdio)));

const streamDone = (stream: Duplex): Effect.Effect<void> =>
	Effect.callback((resume) => {
		const done = () => {
			resume(Effect.void);
		};

		const cleanup = Effect.sync(() => {
			stream.removeListener("end", done);
			stream.removeListener("close", done);
			stream.removeListener("error", done);
		});

		if (stream.destroyed || stream.readableEnded) {
			done();

			return cleanup;
		}

		stream.once("end", done);
		stream.once("close", done);
		stream.once("error", done);

		return cleanup;
	});

const refuse = (options: McpSessionOptions, message: string) =>
	Effect.gen(function* () {
		yield* Effect.logInfo(`mcp ${options.actor}: refused: ${message}`);
		options.stderr?.write(`${message}\n`);
		options.close(1);
	});

export const mcpSession = (
	options: McpSessionOptions
): Effect.Effect<void, never, Scope.Scope | McpServices> =>
	Effect.gen(function* () {
		const room = yield* TableRoom;
		const actor = options.role === "gm" ? GM : options.actor;

		if (actor.startsWith("guest:")) {
			yield* refuse(options, AGENT_NEEDS_KEY);

			return;
		}

		if (options.role !== "gm" && !isMember(yield* room.state, actor)) {
			yield* refuse(options, KNOCK_FIRST);

			return;
		}

		const seat: McpSeat = {
			actor,
			role: options.role,
			rateKey: options.rateKey,
			room: options.room,
		};

		const leave = () => {
			options.close(0);
		};

		yield* (yield* Presence).enter(actor, leave);

		if (actor !== GM) {
			yield* room.changes.pipe(
				Stream.filter((now) => !isMember(now, actor)),
				Stream.take(1),
				Stream.runForEach(() =>
					Effect.andThen(
						Effect.logInfo(`mcp ${actor}: no longer a member; closing`),
						Effect.sync(leave)
					)
				),
				Effect.forkScoped
			);
		}

		yield* Effect.logInfo(`mcp open: ${actor} as ${options.role}`);
		yield* Effect.addFinalizer(() => Effect.logInfo(`mcp closed: ${actor}`));

		const server = yield* Layer.build(
			serverLayer(seat, duplexStdio(options.stream, options.stderr))
		).pipe(
			Effect.andThen(Effect.never),
			Effect.scoped,
			Effect.tapCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logError(`mcp ${actor}: the server stopped`, cause)
			),
			Effect.forkScoped
		);

		yield* Effect.raceFirst(
			streamDone(options.stream),
			Effect.asVoid(Fiber.await(server))
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.andThen(
				Effect.logError(`mcp ${options.actor}: the session failed`, cause),
				Effect.sync(() => {
					options.close(1);
				})
			)
		)
	);
