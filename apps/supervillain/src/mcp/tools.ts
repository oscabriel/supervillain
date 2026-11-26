import {
	commandFromInput,
	helpText,
	ifDefined,
	isRefused,
	listIf,
	notInParty,
	parseInputLine,
	plainText,
	sheetOf,
	sheetTargetFor,
	unknownHelpTopic,
} from "@supervillain/domain";
import {
	Context,
	Effect,
	Match,
	Option,
	Result,
	Schema,
	Scope,
	Stream,
} from "effect";
import { McpSchema, McpServer } from "effect/ai";

import {
	CampaignContent,
	problemLine,
	validateCampaign,
} from "../content/index.ts";
import { ContentWatch } from "../host/ContentWatch.ts";
import {
	autoLine,
	denyLine,
	inviteLine,
	runLine,
	sendCommand,
} from "../host/line.ts";
import type { Reply, Sent } from "../host/line.ts";
import { Refusal, TableRoom } from "../host/TableRoom.ts";
import { LINE_MOST, TOPIC_MOST, WHO_MOST } from "./limits.ts";
import type { Gate } from "./limits.ts";
import { commandTools, inputSchemaOf } from "./schema.ts";
import type { McpSeat, McpServices } from "./seat.ts";
import { FEED_DEFAULT, FEED_MOST, feedOf, viewOf } from "./view.ts";
import type { SeatView, ViewLine } from "./view.ts";

export type ToolResult = McpSchema.CallToolResult;

const WAIT_MOST_MS = 30_000;

const BATCH_MOST = 32;

const STEP_GAP = "2 millis";

const text = (said: string) => ({ type: "text" as const, text: said });

interface Accepted {
	readonly seqs: ReadonlyArray<number>;
	readonly lines: ReadonlyArray<string>;
}

interface Changed {
	readonly changed: boolean;
	readonly seq: number;
	readonly lines: ReadonlyArray<ViewLine>;
}

interface Problems {
	readonly problems: ReadonlyArray<string>;
}

type Structured = Accepted | Changed | Problems | Batched | SeatView;

const toolOk = (said: string, structured?: Structured): ToolResult =>
	new McpSchema.CallToolResult({
		content: [text(said)],
		...ifDefined(structured, (structuredContent) => ({ structuredContent })),
	});

const toolFailed = (said: string, structured?: Structured): ToolResult =>
	new McpSchema.CallToolResult({
		content: [text(said)],
		isError: true,
		...ifDefined(structured, (structuredContent) => ({ structuredContent })),
	});

const json = (value: SeatView): string => JSON.stringify(value, null, 2);

type Provide = <A, E>(
	effect: Effect.Effect<A, E, McpServices>
) => Effect.Effect<A, E>;

const decodeArguments = Schema.decodeUnknownEffect(Schema.JsonObject);

interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: McpSchema.ToolJson;
	readonly readOnly: boolean;
	readonly destructive: boolean;
	readonly handle: (
		input: Schema.JsonObject
	) => Effect.Effect<ToolResult, never, McpServices>;
}

const refuseTool = (said: string) => Effect.succeed(toolFailed(said));

const addTool = (provide: Provide, gate: Gate, spec: ToolSpec) =>
	Effect.gen(function* () {
		const server = yield* McpServer.McpServer;

		yield* server.addTool({
			tool: new McpSchema.Tool({
				name: spec.name,
				description: spec.description,
				inputSchema: spec.inputSchema,
				annotations: {
					title: spec.name,
					readOnlyHint: spec.readOnly,
					destructiveHint: spec.destructive,
					idempotentHint: spec.readOnly,
					openWorldHint: false,
				},
			}),
			annotations: Context.empty(),
			handle: (payload) =>
				provide(
					gate.admit(
						decodeArguments(payload).pipe(
							Effect.matchEffect({
								onFailure: () =>
									refuseTool(`${spec.name} takes its arguments as an object.`),
								onSuccess: spec.handle,
							}),
							Effect.catchCause((cause) =>
								Effect.as(
									Effect.logError(`mcp tool ${spec.name} failed`, cause),
									toolFailed(`${spec.name} failed on the host; try again.`)
								)
							)
						),
						refuseTool
					)
				),
		});
	});

const typed = <F extends Schema.Struct.Fields>(
	name: string,
	fields: F,
	run: (
		input: Schema.Struct<F>["Type"]
	) => Effect.Effect<ToolResult, never, McpServices>
) => {
	const decode = Schema.decodeUnknownEffect(Schema.Struct(fields));

	return (payload: Schema.JsonObject) =>
		decode(payload, { onExcessProperty: "error" }).pipe(
			Effect.matchEffect({
				onFailure: (issue) =>
					Effect.succeed(
						toolFailed(`That doesn't fit ${name}: ${issue.message}`)
					),
				onSuccess: run,
			})
		);
};

const sentResult = (sent: Sent): ToolResult => {
	const lines = sent.lines.map(plainText);

	return toolOk(lines.length === 0 ? "Done." : lines.join("\n"), {
		seqs: sent.seqs,
		lines,
	});
};

const replyResult = (reply: Reply): ToolResult =>
	Match.value(reply).pipe(
		Match.discriminatorsExhaustive("kind")({
			done: (done) => {
				const lines = done.lines.map(plainText);

				return toolOk(lines.length === 0 ? "Done." : lines.join("\n"), {
					seqs: done.lines.map((line) => line.seq),
					lines,
				});
			},
			message: (said) => toolOk(said.text),
			refusal: (refused) => toolFailed(refused.text),
			empty: () => toolFailed("Nothing to send."),
		})
	);

const runCommand = Effect.fn("mcp.runCommand")(function* (
	seat: McpSeat,
	type: string,
	input: Schema.JsonObject
) {
	const { ruleset } = yield* CampaignContent;

	const command = yield* commandFromInput(type, input, ruleset).pipe(
		Effect.mapError((refused) => new Refusal({ message: refused.message }))
	);

	return yield* sendCommand(seat.actor, command, seat.rateKey);
});

const sendLine = Effect.fn("mcp.sendLine")(function* (
	seat: McpSeat,
	line: string
) {
	if (seat.role !== "gm") {
		const { ruleset } = yield* CampaignContent;
		const parsed = parseInputLine(line, "chat", ruleset);

		if (parsed.kind === "sheet") {
			const state = yield* (yield* TableRoom).state;
			const target = sheetTargetFor(state, seat.actor, parsed.who, ruleset);

			if (target === undefined) {
				return toolFailed(notInParty(parsed.who));
			}

			const sheet = sheetOf(state, target, ruleset);

			return isRefused(sheet) ? toolFailed(sheet.refusal) : toolOk(sheet);
		}
	}

	return replyResult(yield* runLine(seat.actor, line, "exec", seat.rateKey));
});

const commandToolsOf = (seat: McpSeat) =>
	Effect.gen(function* () {
		const { ruleset } = yield* CampaignContent;

		return commandTools(ruleset, seat.role === "gm").map((tool): ToolSpec => ({
			name: tool.name,
			description: `${tool.spec.summary} At the table: ${tool.spec.usage}.${tool.spec.gmOnly ? " GM only." : ""}`,
			inputSchema: tool.inputSchema,
			readOnly: false,
			destructive: tool.spec.gmOnly,
			handle: (payload) =>
				runCommand(seat, tool.spec.type, payload).pipe(
					Effect.match({
						onFailure: (refused) => toolFailed(refused.message),
						onSuccess: sentResult,
					})
				),
		}));
	});

const bounded = (most: number) => Schema.String.check(Schema.isMaxLength(most));

const LINE = { line: bounded(LINE_MOST) };

const STATE = {
	feed_limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: FEED_MOST }))
	),
};

const WAIT = {
	after_seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	timeout_ms: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: WAIT_MOST_MS }))
	),
};

const HELP = { topic: Schema.optionalKey(bounded(TOPIC_MOST)) };

const STEP = Schema.Struct({
	type: bounded(TOPIC_MOST),
	args: Schema.optionalKey(Schema.JsonObject),
});

const BATCH = {
	commands: Schema.Array(STEP).check(Schema.isMaxLength(BATCH_MOST)),
	stop_on_refusal: Schema.optionalKey(Schema.Boolean),
};

const AUTO = { on: Schema.Boolean };

const DENY = { who: bounded(WHO_MOST) };

const INVITE = {
	uses: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	minutes: Schema.optionalKey(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
	),
};

const NOTHING = {};

const waitForChange = (afterSeq: number, timeoutMs: number) =>
	Effect.gen(function* () {
		const room = yield* TableRoom;
		const { ruleset } = yield* CampaignContent;

		const changed = yield* room.changes.pipe(
			Stream.filter((state) => state.seq > afterSeq),
			Stream.runHead,
			Effect.timeoutOption(timeoutMs),
			Effect.map(Option.flatten)
		);

		const state = Option.isSome(changed) ? changed.value : yield* room.state;
		const lines = feedOf(state, ruleset, afterSeq);

		const said = Option.isNone(changed)
			? `Nothing changed after seq ${afterSeq}.`
			: lines.map((line) => plainText(line)).join("\n");

		return toolOk(said || `The table changed (now seq ${state.seq}).`, {
			changed: Option.isSome(changed),
			seq: state.seq,
			lines,
		});
	});

interface Batched {
	readonly steps: ReadonlyArray<StepOutcome>;
	readonly notRun: number;
}

interface StepOutcome {
	readonly step: number;
	readonly type: string;
	readonly ok: boolean;
	readonly seqs: ReadonlyArray<number>;
	readonly lines: ReadonlyArray<string>;
	readonly refusal?: string;
}

const batch = (
	seat: McpSeat,
	steps: ReadonlyArray<typeof STEP.Type>,
	stopOnRefusal: boolean
) =>
	Effect.gen(function* () {
		const outcomes: Array<StepOutcome> = [];

		for (const [index, step] of steps.entries()) {
			if (index > 0) {
				yield* Effect.sleep(STEP_GAP);
			}

			const ran = yield* Effect.result(
				runCommand(seat, step.type, step.args ?? {})
			);

			const outcome: StepOutcome = Result.isSuccess(ran)
				? {
						step: index + 1,
						type: step.type,
						ok: true,
						seqs: ran.success.seqs,
						lines: ran.success.lines.map(plainText),
					}
				: {
						step: index + 1,
						type: step.type,
						ok: false,
						seqs: [],
						lines: [],
						refusal: ran.failure.message,
					};

			outcomes.push(outcome);

			if (!outcome.ok && stopOnRefusal) {
				break;
			}
		}

		const refused = outcomes.filter((o) => !o.ok);
		const notRun = steps.length - outcomes.length;

		const said = [
			...outcomes.map((o) =>
				o.ok
					? `${o.step}. /${o.type}: ${o.lines.join(" · ") || "done"}`
					: `${o.step}. /${o.type} refused: ${o.refusal ?? ""}`
			),
			...listIf(notRun > 0, () => [
				`${notRun} later step${notRun === 1 ? "" : "s"} not run.`,
			]),
		].join("\n");

		const structured: Batched = { steps: outcomes, notRun };

		return refused.length === 0
			? toolOk(said, structured)
			: toolFailed(said, structured);
	});

const metaTools = (seat: McpSeat, gate: Gate): ReadonlyArray<ToolSpec> => [
	{
		name: "send_line",
		description:
			"Type one line at the table exactly as a player would at their seat: chat, an emote, or a /command (see help). Prefer the cmd_ tools for commands: they say what each takes.",
		inputSchema: inputSchemaOf(LINE),
		readOnly: false,
		destructive: false,
		handle: typed("send_line", LINE, ({ line }) => sendLine(seat, line)),
	},
	{
		name: "get_table_state",
		description: `What your seat sees right now as JSON: the table's seq, your name, who is here, the party, the stage, the combat band, the map and the last feed_limit feed lines (default ${FEED_DEFAULT}, at most ${FEED_MOST}).`,
		inputSchema: inputSchemaOf(STATE),
		readOnly: true,
		destructive: false,
		handle: typed("get_table_state", STATE, (input) =>
			Effect.map(viewOf(seat, input.feed_limit ?? FEED_DEFAULT), (view) =>
				toolOk(json(view), view)
			)
		),
	},
	{
		name: "wait_for_change",
		description: `Wait until the table moves past after_seq (the seq from get_table_state or a previous wait), then return the new feed lines. Gives up after timeout_ms (default and most ${WAIT_MOST_MS}).`,
		inputSchema: inputSchemaOf(WAIT),
		readOnly: true,
		destructive: false,
		handle: typed("wait_for_change", WAIT, (input) =>
			gate.once(
				waitForChange(input.after_seq, input.timeout_ms ?? WAIT_MOST_MS),
				refuseTool
			)
		),
	},
	{
		name: "help",
		description:
			"The table's help: every command this campaign's rules take, or one command's (topic: its name, like roll or /roll).",
		inputSchema: inputSchemaOf(HELP),
		readOnly: true,
		destructive: false,
		handle: typed("help", HELP, (input) =>
			Effect.gen(function* () {
				const { ruleset } = yield* CampaignContent;
				const unknown = unknownHelpTopic(input.topic, ruleset);

				return unknown === undefined
					? toolOk(helpText(seat.actor, input.topic, "exec", ruleset))
					: toolFailed(unknown);
			})
		),
	},
];

const gmTools = (seat: McpSeat): ReadonlyArray<ToolSpec> => [
	{
		name: "batch_commands",
		description: `Run up to ${BATCH_MOST} table commands in order, each {type, args} as its cmd_<type> tool takes them. Each accepted step is logged as its own entry, so /undo takes back one step at a time, newest first. stop_on_refusal (default true) stops at the first refused step and leaves the rest unrun; steps already accepted stay.`,
		inputSchema: inputSchemaOf(BATCH),
		readOnly: false,
		destructive: true,
		handle: typed("batch_commands", BATCH, (input) =>
			batch(seat, input.commands, input.stop_on_refusal ?? true)
		),
	},
	{
		name: "reload_content",
		description:
			"Read the campaign's files again now (the table also notices edits by itself) and list any problems found.",
		inputSchema: inputSchemaOf(NOTHING),
		readOnly: false,
		destructive: false,
		handle: typed("reload_content", NOTHING, () =>
			Effect.gen(function* () {
				const watch = yield* ContentWatch;
				yield* watch.recheck;
				const problems = yield* watch.problems.get;

				return toolOk(
					problems.length === 0
						? "Reloaded the campaign: no problems."
						: problems.join("\n"),
					{ problems }
				);
			})
		),
	},
	{
		name: "validate_content",
		description:
			"Check the campaign's Markdown and sheets the way `supervillain check` does, without changing the table.",
		inputSchema: inputSchemaOf(NOTHING),
		readOnly: true,
		destructive: false,
		handle: typed("validate_content", NOTHING, () =>
			Effect.gen(function* () {
				const content = yield* CampaignContent;

				return yield* validateCampaign(content.dir).pipe(
					Effect.map(({ problems }) => {
						const lines = problems.map(problemLine);

						return toolOk(
							lines.length === 0 ? "No problems." : lines.join("\n"),
							{ problems: lines }
						);
					}),
					Effect.catch((error) => Effect.succeed(toolFailed(error.message)))
				);
			})
		),
	},
	{
		name: "deny_knock",
		description:
			"Turn away someone knocking (who: their name, or the start of their key's fingerprint); they can't knock again for a while.",
		inputSchema: inputSchemaOf(DENY),
		readOnly: false,
		destructive: true,
		handle: typed("deny_knock", DENY, ({ who }) =>
			Effect.map(denyLine(seat.actor, who), replyResult)
		),
	},
	{
		name: "create_invite",
		description:
			"Make an invite that seats whoever uses it without knocking: uses (default 1) and minutes it lasts. The token is never written to the log.",
		inputSchema: inputSchemaOf(INVITE),
		readOnly: false,
		destructive: false,
		handle: typed("create_invite", INVITE, (input) =>
			Effect.map(
				inviteLine(seat.actor, {
					...ifDefined(input.uses, (uses) => ({ uses })),
					...ifDefined(input.minutes, (minutes) => ({ minutes })),
				}),
				replyResult
			)
		),
	},
];

const autoFoesTool = (seat: McpSeat): ToolSpec => ({
	name: "set_auto_foes",
	description:
		"Let the table play the foes' turns (on: true) or play them yourself (on: false).",
	inputSchema: inputSchemaOf(AUTO),
	readOnly: false,
	destructive: false,
	handle: typed("set_auto_foes", AUTO, ({ on }) =>
		Effect.map(autoLine(seat.actor, on), replyResult)
	),
});

export const registerTools = (seat: McpSeat, gate: Gate) =>
	Effect.gen(function* () {
		const services = Context.omit(Scope.Scope)(
			yield* Effect.context<McpServices>()
		);

		const provide: Provide = (effect) =>
			Effect.provideContext(effect, services);

		const { ruleset } = yield* CampaignContent;
		const commanded = yield* commandToolsOf(seat);

		const gm =
			seat.role === "gm"
				? [
						...gmTools(seat),
						...listIf(ruleset === "set-world", () => [autoFoesTool(seat)]),
					]
				: [];

		yield* Effect.forEach(
			[...metaTools(seat, gate), ...gm, ...commanded],
			(spec) => addTool(provide, gate, spec),
			{ concurrency: 1, discard: true }
		);
	});
