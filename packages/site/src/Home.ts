import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { HeroWaves } from "./HeroWaves.ts";
import { Message } from "./Model.ts";
import type { Model } from "./Model.ts";
import { RELAY_INFO } from "./RelayInfo.ts";
import type { RelayInfo } from "./RelayInfo.ts";
import { docRouter } from "./Route.ts";
import { terminalView } from "./Terminal.ts";

export const JOIN_COMMAND = "ssh supervillain.sh";

const ROWS: ReadonlyArray<readonly [string, string, string]> = [
	[
		"Zero friction at game night",
		"Players already have ssh. Share one address, let them in at the door, and play with nothing to install.",
		"ssh handle/table@supervillain.sh",
	],
	[
		"Stage and battlemap in one place",
		"Pin scenes, NPCs, handouts, and trackers on the campaign stage, then drop straight into pixel-art or text combat.",
		"/show · /move · /pr",
	],
	[
		"Plain files on the GM's disk",
		"Your campaign is typed Markdown, text maps, and an append-only JSONL log. Run supervillain to host or create tables.",
		"curl -fsSL https://supervillain.sh/install | sh",
	],
	[
		"Four rulesets built in",
		"Draw Steel, set.world, PF2e Remaster under the ORC License, and freeform, all sharing one log and stage.",
		"Draw Steel · set.world · PF2e · Freeform",
	],
	[
		"Bring an agent live",
		"Attach Claude Code, Codex, Cursor, or T3 Code over MCP to run rolls, moves, and scenes in real time with /undo.",
		"supervillain mcp · mcp-1@supervillain.sh",
	],
];

const copyFieldButton = (
	h: HtmlBuilder<Message>,
	id: string,
	text: string,
	copiedBlock: string,
	ariaLabel: string,
	label = "Copy"
): Html => {
	const isCopied = copiedBlock === id;

	return h.button(
		[
			h.Type("button"),
			h.Class("code-copy"),
			h.DataAttribute("copied", isCopied ? "true" : "false"),
			h.AriaLabel(isCopied ? `Copied ${ariaLabel}` : `Copy ${ariaLabel}`),
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

const verifyBlockView = (
	relay: RelayInfo,
	copiedBlock: string,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
	if (relay.fingerprint !== "" && relay.knownHostsLine !== "") {
		return [
			h.div(
				[h.Class("code-block what-verify-block")],
				[
					h.div(
						[h.Class("code-block-bar")],
						[
							h.span(
								[h.Class("code-block-lang")],
								["ED25519 fingerprint · compare with SSH prompt"]
							),
							copyFieldButton(
								h,
								"what-fingerprint",
								relay.fingerprint,
								copiedBlock,
								"fingerprint"
							),
						]
					),
					h.pre([], [h.code([], [relay.fingerprint])]),
				]
			),
			h.div(
				[h.Class("code-block what-verify-block")],
				[
					h.div(
						[h.Class("code-block-bar")],
						[
							h.span(
								[h.Class("code-block-lang")],
								["Add this to ~/.ssh/known_hosts"]
							),
							copyFieldButton(
								h,
								"what-known-hosts",
								relay.knownHostsLine,
								copiedBlock,
								"known_hosts line"
							),
						]
					),
					h.pre([], [h.code([], [relay.knownHostsLine])]),
				]
			),
		];
	}

	const scanCommand = `ssh-keyscan -t ed25519 ${relay.host} | ssh-keygen -lf -`;

	return [
		h.div(
			[h.Class("code-block what-verify-block")],
			[
				h.div(
					[h.Class("code-block-bar")],
					[
						h.span([h.Class("code-block-lang")], ["Check live fingerprint"]),
						copyFieldButton(
							h,
							"what-keyscan",
							scanCommand,
							copiedBlock,
							"verification command"
						),
					]
				),
				h.pre([], [h.code([], [scanCommand])]),
			]
		),
	];
};

export const whatIsDialogView = (
	copiedBlock: string,
	h: HtmlBuilder<Message>,
	relay: RelayInfo = RELAY_INFO
): Html =>
	h.div(
		[h.Class("what-backdrop"), h.OnClick(Message.ClickedCloseWhatIs())],
		[
			h.div(
				[
					h.Id("what-is-dialog"),
					h.Class("what-dialog"),
					h.Role("dialog"),
					h.AriaModal(true),
					h.AriaLabelledBy("what-is-title"),
					h.Tabindex(-1),
					h.OnClick(Message.CompletedNavigate(), { propagation: "Stop" }),
					h.OnKeyDownPreventDefault((key) =>
						key === "Escape"
							? Option.some(Message.ClickedCloseWhatIs())
							: Option.none()
					),
				],
				[
					h.div(
						[h.Class("what-head")],
						[
							h.div(
								[h.Class("what-head-copy")],
								[
									h.span([h.Class("what-kicker")], ["About this command"]),
									h.h2(
										[h.Id("what-is-title"), h.Class("what-title")],
										[JOIN_COMMAND]
									),
								]
							),
							h.button(
								[
									h.Type("button"),
									h.Class("what-close"),
									h.AriaLabel("Close dialog"),
									h.OnClick(Message.ClickedCloseWhatIs()),
								],
								["×"]
							),
						]
					),
					h.p(
						[h.Class("what-lead")],
						[
							"Runs OpenSSH in your terminal and opens the supervillain lobby. Nothing is installed on your machine and no account is created.",
						]
					),
					h.div(
						[h.Class("what-verify")],
						[
							h.h3([h.Class("what-subhead")], ["Verify the host key"]),
							h.p(
								[h.Class("what-note")],
								[
									"The first time you connect, ssh shows this server's fingerprint so you can confirm you reached the real host. Compare it with the fingerprint below, or add the line to ",
									h.code([], ["~/.ssh/known_hosts"]),
									" before you connect:",
								]
							),
							...verifyBlockView(relay, copiedBlock, h),
						]
					),
					h.div(
						[h.Class("what-foot")],
						[
							h.a(
								[h.Href(docRouter({ slug: "playing" })), h.Class("what-link")],
								["Read the player guide →"]
							),
							h.button(
								[
									h.Type("button"),
									h.Class("what-done"),
									h.OnClick(Message.ClickedCloseWhatIs()),
								],
								["Close"]
							),
						]
					),
				]
			),
		]
	);

const heroView = (
	copied: boolean,
	whatIsOpen: boolean,
	h: HtmlBuilder<Message>
): Html =>
	h.section(
		[h.Class("g-hero-wrap")],
		[
			h.canvas(
				[h.Class("g-hero-canvas"), h.AriaHidden(true), h.OnMount(HeroWaves())],
				[]
			),
			h.div([h.Class("g-hero-vignette"), h.AriaHidden(true)], []),
			h.div(
				[h.Class("g-hero")],
				[
					h.button(
						[
							h.Type("button"),
							h.Class("g-h1"),
							h.DataAttribute("copied", copied ? "true" : "false"),
							h.AriaLabel(
								copied
									? "Copied ssh supervillain.sh"
									: "Copy ssh supervillain.sh"
							),
							h.OnClick(Message.ClickedCopyCommand()),
						],
						[
							h.span([h.Class("g-ssh")], ["ssh"]),
							h.span([], ["supervillain.sh"]),
						]
					),
					h.div(
						[h.Class("g-hero-actions")],
						[
							h.button(
								[
									h.Type("button"),
									h.Class("g-copy-hint"),
									h.DataAttribute("copied", copied ? "true" : "false"),
									h.OnClick(Message.ClickedCopyCommand()),
								],
								[
									h.span(
										[h.Class("copy-state")],
										[
											h.span(
												[h.Class("s-idle"), h.AriaHidden(copied)],
												["Click to copy"]
											),
											h.span(
												[h.Class("s-done"), h.AriaHidden(!copied)],
												["Copied"]
											),
										]
									),
								]
							),
							h.span([h.Class("g-hero-sep"), h.AriaHidden(true)], ["·"]),
							h.button(
								[
									h.Type("button"),
									h.Class("g-copy-hint"),
									h.AriaExpanded(whatIsOpen),
									h.AriaControls("what-is-dialog"),
									h.OnClick(Message.ClickedOpenWhatIs()),
								],
								["What is this?"]
							),
						]
					),
				]
			),
		]
	);

const editorialView = (h: HtmlBuilder<Message>): Html =>
	h.section(
		[h.Class("g-editorial")],
		[
			h.div(
				[h.Class("g-intro")],
				[
					h.h2([h.Class("g-statement")], ["Your terminal is the table."]),
					h.p(
						[h.Class("g-substatement")],
						[
							"No browser tabs, no downloads, no accounts. One ssh command puts everyone at the same campaign stage and board.",
						]
					),
				]
			),
			h.div(
				[h.Class("g-rows")],
				ROWS.map(([key, value, command]) =>
					h.div(
						[h.Class("g-row")],
						[
							h.div([h.Class("g-row-k")], [key]),
							h.div([h.Class("g-row-v")], [value]),
							h.div([h.Class("g-row-cmd")], [command]),
						]
					)
				)
			),
		]
	);

export const homeView = (
	model: Model,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
	const sections: Array<Html> = [
		heroView(model.copied, model.whatIsOpen, h),
		terminalView(model.demo, h, model.mapMode, {
			autoplay: model.autoplay,
			autoplayLine: model.autoplayLine,
		}),
		editorialView(h),
	];

	if (model.whatIsOpen) {
		sections.push(whatIsDialogView(model.copiedBlock, h));
	}

	return sections;
};
