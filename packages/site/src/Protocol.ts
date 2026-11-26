import type { RulesetName } from "@supervillain/domain";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Model.ts";
import type { Model } from "./Model.ts";
import { PROTOCOL_SNAPSHOT } from "./ProtocolSnapshot.ts";
import { ALL_RULESETS, RULESET_LABELS } from "./ProtocolTypes.ts";
import type {
	CommandDoc,
	MetaToolDoc,
	ParamEntry,
	ProtocolRole,
} from "./ProtocolTypes.ts";
import { docRouter } from "./Route.ts";

export const PROTOCOL_TITLE = "Protocol & MCP reference";

export const PROTOCOL_SUMMARY =
	"Interactive catalog of every MCP tool, typed table command, resource URI, and JSON Schema generated directly from the rules engine.";

export const PROTOCOL_ANCHORS: ReadonlyArray<{
	readonly id: string;
	readonly text: string;
}> = [
	{ id: "mcp-tools", text: "MCP tools" },
	{ id: "table-commands", text: "Table commands" },
	{ id: "mcp-resources", text: "MCP resources" },
	{ id: "campaign-schemas", text: "Campaign schemas" },
	{ id: "log-envelope", text: "Log envelope" },
];

const matchesQuery = (haystack: string, query: string): boolean => {
	const needle = query.trim().toLowerCase();

	return needle === "" || haystack.toLowerCase().includes(needle);
};

const copyButton = (
	h: HtmlBuilder<Message>,
	id: string,
	text: string,
	copiedBlock: string,
	label = "Copy schema"
): Html => {
	const isCopied = copiedBlock === id;

	return h.button(
		[
			h.Type("button"),
			h.Class("code-copy"),
			h.DataAttribute("copied", isCopied ? "true" : "false"),
			h.AriaLabel(isCopied ? "Copied" : label),
			h.OnClick(Message.ClickedCopyCode({ id, text })),
		],
		[
			h.span(
				[h.Class("copy-label copy-idle"), h.AriaHidden(isCopied)],
				[label]
			),
			h.span(
				[h.Class("copy-label copy-done"), h.AriaHidden(!isCopied)],
				["Copied"]
			),
		]
	);
};

const paramsView = (
	h: HtmlBuilder<Message>,
	params: ReadonlyArray<ParamEntry>
): Html => {
	if (params.length === 0) {
		return h.p([h.Class("proto-empty-params")], ["Takes no input arguments."]);
	}

	return h.div(
		[h.Class("table proto-params")],
		[
			h.table(
				[],
				[
					h.thead(
						[],
						[
							h.tr(
								[],
								[
									h.th([], ["Field"]),
									h.th([], ["Type"]),
									h.th([], ["Required"]),
								]
							),
						]
					),
					h.tbody(
						[],
						params.map((param) =>
							h.tr(
								[],
								[
									h.td([], [h.code([], [param.name])]),
									h.td([], [h.code([], [param.type])]),
									h.td(
										[],
										[
											h.span(
												[h.Class(param.required ? "proto-req" : "proto-opt")],
												[param.required ? "required" : "optional"]
											),
										]
									),
								]
							)
						)
					),
				]
			),
		]
	);
};

const schemaBlock = (
	h: HtmlBuilder<Message>,
	id: string,
	jsonText: string,
	copiedBlock: string,
	label = "JSON Schema"
): Html =>
	h.div(
		[h.Class("code-block")],
		[
			h.div(
				[h.Class("code-block-bar")],
				[
					h.span([h.Class("code-block-lang")], [label]),
					copyButton(h, id, jsonText, copiedBlock, "Copy"),
				]
			),
			h.pre([], [h.code([], [jsonText])]),
		]
	);

const metaToolCard = (
	h: HtmlBuilder<Message>,
	tool: MetaToolDoc,
	copiedBlock: string
): Html => {
	const badges: Array<Html> = [
		h.span(
			[h.Class(tool.gmOnly ? "proto-badge is-gm" : "proto-badge is-player")],
			[tool.gmOnly ? "GM only" : "Player + GM"]
		),
	];

	if (tool.readOnly) {
		badges.push(h.span([h.Class("proto-badge")], ["read-only"]));
	}

	return h.details(
		[h.Class("proto-card")],
		[
			h.summary(
				[h.Class("proto-card-head")],
				[
					h.div(
						[h.Class("proto-card-title")],
						[
							h.span([h.Class("summary-chevron"), h.AriaHidden(true)], ["▸"]),
							h.code([h.Class("proto-tool-name")], [tool.name]),
							...badges,
						]
					),
					h.span([h.Class("proto-card-desc")], [tool.description]),
				]
			),
			h.div(
				[h.Class("proto-card-body")],
				[
					paramsView(h, tool.params),
					schemaBlock(h, `meta-${tool.name}`, tool.jsonSchema, copiedBlock),
				]
			),
		]
	);
};

const commandCard = (
	h: HtmlBuilder<Message>,
	cmd: CommandDoc,
	ruleset: RulesetName,
	copiedBlock: string
): Html => {
	const bodyChildren: Array<Html> = [
		h.div(
			[h.Class("proto-usage-row")],
			[
				h.span([h.Class("proto-meta-k")], ["Slash command"]),
				h.code([], [cmd.usage]),
			]
		),
		paramsView(h, cmd.params),
	];

	if (cmd.hostFacts.length > 0) {
		bodyChildren.push(
			h.div(
				[h.Class("proto-host-facts")],
				[
					h.span(
						[h.Class("proto-meta-k")],
						["Host-filled (stripped from MCP)"]
					),
					h.span(
						[h.Class("proto-fact-list")],
						cmd.hostFacts.map((key) => h.code([], [key]))
					),
				]
			)
		);
	}

	bodyChildren.push(
		schemaBlock(h, `cmd-${ruleset}-${cmd.type}`, cmd.jsonSchema, copiedBlock)
	);

	return h.details(
		[h.Class("proto-card")],
		[
			h.summary(
				[h.Class("proto-card-head")],
				[
					h.div(
						[h.Class("proto-card-title")],
						[
							h.span([h.Class("summary-chevron"), h.AriaHidden(true)], ["▸"]),
							h.code([h.Class("proto-tool-name")], [cmd.toolName]),
							h.code([h.Class("proto-slash-chip")], [`/${cmd.type}`]),
							h.span(
								[
									h.Class(
										cmd.gmOnly ? "proto-badge is-gm" : "proto-badge is-player"
									),
								],
								[cmd.gmOnly ? "GM only" : "Player + GM"]
							),
						]
					),
					h.span([h.Class("proto-card-desc")], [cmd.summary]),
				]
			),
			h.div([h.Class("proto-card-body")], bodyChildren),
		]
	);
};

const controlsView = (
	h: HtmlBuilder<Message>,
	ruleset: RulesetName,
	role: ProtocolRole,
	query: string,
	shownCommands: number,
	totalCommands: number
): Html =>
	h.div(
		[h.Class("proto-controls")],
		[
			h.div(
				[h.Class("proto-control-row")],
				[
					h.div(
						[h.Class("proto-group"), h.Role("group"), h.AriaLabel("Ruleset")],
						ALL_RULESETS.map((each) =>
							h.button(
								[
									h.Type("button"),
									h.Class(
										each === ruleset ? "proto-tab is-active" : "proto-tab"
									),
									h.AriaPressed(each === ruleset ? "true" : "false"),
									h.OnClick(Message.ClickedProtocolRuleset({ ruleset: each })),
								],
								[RULESET_LABELS[each]]
							)
						)
					),
					h.div(
						[h.Class("proto-group"), h.Role("group"), h.AriaLabel("Seat role")],
						[
							h.button(
								[
									h.Type("button"),
									h.Class(role === "gm" ? "proto-tab is-active" : "proto-tab"),
									h.AriaPressed(role === "gm" ? "true" : "false"),
									h.OnClick(Message.ClickedProtocolRole({ role: "gm" })),
								],
								["GM (full)"]
							),
							h.button(
								[
									h.Type("button"),
									h.Class(
										role === "player" ? "proto-tab is-active" : "proto-tab"
									),
									h.AriaPressed(role === "player" ? "true" : "false"),
									h.OnClick(Message.ClickedProtocolRole({ role: "player" })),
								],
								["Player (seat-safe)"]
							),
						]
					),
				]
			),
			h.div(
				[h.Class("proto-search-row")],
				[
					h.input([
						h.Type("search"),
						h.Class("proto-search"),
						h.Value(query),
						h.Placeholder(
							"Filter tools, commands, or /slash usage (for example move, roll, show)..."
						),
						h.AriaLabel("Filter tools and commands"),
						h.OnInput((value) => Message.TypedProtocolQuery({ query: value })),
					]),
					h.span(
						[h.Class("proto-count")],
						[
							`${shownCommands} of ${totalCommands} commands · `,
							h.a(
								[
									h.Href(`/schemas/mcp/${ruleset}.json`),
									h.Class("proto-download"),
								],
								[`${ruleset}.json`]
							),
						]
					),
				]
			),
		]
	);

const commandGroupView = (
	h: HtmlBuilder<Message>,
	title: string,
	commands: ReadonlyArray<CommandDoc>,
	ruleset: RulesetName,
	copiedBlock: string
): ReadonlyArray<Html> =>
	commands.length === 0
		? []
		: [
				h.h3([h.Class("proto-subhead")], [`${title} (${commands.length})`]),
				h.div(
					[h.Class("proto-list")],
					commands.map((cmd) => commandCard(h, cmd, ruleset, copiedBlock))
				),
			];

export const protocolContentView = (
	model: Model,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
	const ruleset = model.protocolRuleset;
	const role = model.protocolRole;
	const query = model.protocolQuery;
	const isGm = role === "gm";

	const allMeta = PROTOCOL_SNAPSHOT.metaTools.filter(
		(tool) => tool.rulesets.includes(ruleset) && (isGm || !tool.gmOnly)
	);

	const visibleMeta = allMeta.filter((tool) =>
		matchesQuery(`${tool.name} ${tool.description}`, query)
	);

	const allCommands = PROTOCOL_SNAPSHOT.commands[ruleset].filter(
		(cmd) => isGm || !cmd.gmOnly
	);

	const visibleCommands = allCommands.filter((cmd) =>
		matchesQuery(
			`${cmd.toolName} /${cmd.type} ${cmd.usage} ${cmd.summary}`,
			query
		)
	);

	const rulesetCommands = visibleCommands.filter(
		(cmd) => cmd.scope === "ruleset"
	);

	const stageCommands = visibleCommands.filter((cmd) => cmd.scope === "stage");
	const coreCommands = visibleCommands.filter((cmd) => cmd.scope === "core");

	const visibleResources = PROTOCOL_SNAPSHOT.resources.filter(
		(res) =>
			(isGm || !res.gmOnly) &&
			matchesQuery(`${res.uri} ${res.name} ${res.description}`, query)
	);

	const commandBlocks: Array<Html> =
		visibleCommands.length === 0
			? [
					h.p(
						[h.Class("proto-empty")],
						["No table commands match that filter."]
					),
				]
			: [
					...commandGroupView(
						h,
						`${RULESET_LABELS[ruleset]} commands`,
						rulesetCommands,
						ruleset,
						model.copiedBlock
					),
					...commandGroupView(
						h,
						"Campaign stage",
						stageCommands,
						ruleset,
						model.copiedBlock
					),
					...commandGroupView(
						h,
						"Core table",
						coreCommands,
						ruleset,
						model.copiedBlock
					),
				];

	return [
		h.p(
			[h.Class("proto-intro")],
			[
				"Supervillain has no cloud REST API. Every table runs locally on the GM's machine and exposes its typed domain commands over MCP (",
				h.code([], ["supervillain mcp"]),
				" locally or the ",
				h.code([], ["mcp-1@supervillain.sh"]),
				" SSH subsystem). See ",
				h.a([h.Href(docRouter({ slug: "agents" }))], ["Connect an agent"]),
				" for setup.",
			]
		),
		controlsView(
			h,
			ruleset,
			role,
			query,
			visibleCommands.length,
			allCommands.length
		),
		h.section(
			[h.Class("proto-section")],
			[
				h.h2([h.Id("mcp-tools")], ["MCP tools"]),
				h.p(
					[h.Class("proto-note")],
					[
						"Built-in control plane tools for reading seat state, waiting on live table changes, validating campaign files, and running batches.",
					]
				),
				visibleMeta.length === 0
					? h.p(
							[h.Class("proto-empty")],
							["No built-in tools match that filter."]
						)
					: h.div(
							[h.Class("proto-list")],
							visibleMeta.map((tool) =>
								metaToolCard(h, tool, model.copiedBlock)
							)
						),
			]
		),
		h.section(
			[h.Class("proto-section")],
			[
				h.h2([h.Id("table-commands")], ["Table commands"]),
				h.p(
					[h.Class("proto-note")],
					[
						"Every slash command is exposed as a typed cmd_* MCP tool with host-fact fields stripped and enforced by the same pure rules engine. Click any command to inspect its parameters and JSON Schema.",
					]
				),
				...commandBlocks,
			]
		),
		h.section(
			[h.Class("proto-section")],
			[
				h.h2([h.Id("mcp-resources")], ["MCP resources"]),
				h.p(
					[h.Class("proto-note")],
					[
						"Read-only URIs exposed by the table over MCP. Toggle Player vs. GM above to inspect the visibility boundary.",
					]
				),
				h.div(
					[h.Class("table")],
					[
						h.table(
							[],
							[
								h.thead(
									[],
									[
										h.tr(
											[],
											[
												h.th([], ["URI"]),
												h.th([], ["Access"]),
												h.th([], ["MIME"]),
												h.th([], ["Description"]),
											]
										),
									]
								),
								h.tbody(
									[],
									visibleResources.map((res) =>
										h.tr(
											[],
											[
												h.td([], [h.code([], [res.uri])]),
												h.td(
													[],
													[
														h.span(
															[
																h.Class(
																	res.gmOnly
																		? "proto-badge is-gm"
																		: "proto-badge is-player"
																),
															],
															[res.gmOnly ? "GM only" : "Player + GM"]
														),
													]
												),
												h.td([], [h.code([], [res.mimeType])]),
												h.td([], [res.description]),
											]
										)
									)
								),
							]
						),
					]
				),
			]
		),
		h.section(
			[h.Class("proto-section")],
			[
				h.h2([h.Id("campaign-schemas")], ["Campaign schemas"]),
				h.p(
					[h.Class("proto-note")],
					[
						"Run ",
						h.code([], ["supervillain schema <campaign-dir>"]),
						" to write Draft 2020-12 or Draft 07 JSON Schema files for your campaign's ruleset, or let a GM agent read ",
						h.code([], ["supervillain://schema/{kind}"]),
						" live.",
					]
				),
				h.div(
					[h.Class("table")],
					[
						h.table(
							[],
							[
								h.thead(
									[],
									[
										h.tr(
											[],
											[
												h.th([], ["Kind"]),
												h.th([], ["Files"]),
												h.th([], ["Resource URI"]),
												h.th([], ["Purpose"]),
											]
										),
									]
								),
								h.tbody(
									[],
									PROTOCOL_SNAPSHOT.campaignSchemas.map((entry) =>
										h.tr(
											[],
											[
												h.td([], [h.code([], [entry.kind])]),
												h.td([], [h.code([], [entry.glob])]),
												h.td([], [h.code([], [entry.uri])]),
												h.td([], [entry.purpose]),
											]
										)
									)
								),
							]
						),
					]
				),
			]
		),
		h.section(
			[h.Class("proto-section")],
			[
				h.h2([h.Id("log-envelope")], ["Log envelope"]),
				h.p(
					[h.Class("proto-note")],
					[
						"Every accepted command appends deterministic JSON objects to ",
						h.code([], ["events.jsonl"]),
						", one line per event. Download ",
						h.a(
							[
								h.Href("/schemas/envelope.schema.json"),
								h.Class("proto-download"),
							],
							["envelope.schema.json"]
						),
						" or inspect the schema below.",
					]
				),
				schemaBlock(
					h,
					"envelope-schema",
					PROTOCOL_SNAPSHOT.envelopeSchemaJson,
					model.copiedBlock,
					"JSON Schema · events.jsonl"
				),
			]
		),
	];
};
