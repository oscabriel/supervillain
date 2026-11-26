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
		"Your players already have OpenSSH. Share one table address, let newcomers in at the door, and everyone sits at the same session with nothing to install and no account to make.",
		"ssh handle/table@supervillain.sh",
	],
	[
		"Campaign stage and battlemap",
		"Keep every hero visible while you put scenes, NPCs, handouts, and trackers onto the table, then drop straight into tactical pixel-art or text combat without switching tools.",
		"/show · /move · /pr",
	],
	[
		"File over app, on your disk",
		"Your campaign is a plain folder of typed Markdown files, text maps, and an append-only JSONL log on the GM's machine. Open bare supervillain to launch tables or create new ones.",
		"curl -fsSL https://supervillain.sh/install | sh",
	],
	[
		"Four rulesets out of the box",
		"Built-in support for Draw Steel, set.world, PF2e Remaster under the ORC License, and a lightweight freeform table, all sharing one log and campaign stage.",
		"Draw Steel · set.world · PF2e · Freeform",
	],
	[
		"Bring your agent live",
		"Connect Claude Code, Codex, Cursor, or T3 Code over MCP to dictate scene updates, rolls, and moves while everyone watches the table update in real time, with full /undo.",
		"supervillain mcp · mcp-1@supervillain.sh",
	],
];

const LOBBY_ITEMS: ReadonlyArray<readonly [string, string]> = [
	[
		"1 Tables",
		"Sit down at open tables that know your SSH key, or enter any table's handle/table address.",
	],
	[
		"2 Try a Table",
		"Open a private, in-memory Draw Steel sandbox encounter right in your terminal with nothing saved.",
	],
	[
		"3 Create a Table",
		"Claim a GM handle bound to your SSH key and get a setup command to host campaigns from your machine.",
	],
];

const copyFieldButton = (
	h: HtmlBuilder<Message>,
	id: string,
	text: string,
	copiedBlock: string,
	ariaLabel: string
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
				["Copy"]
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
							h.span([h.Class("code-block-lang")], ["ED25519 fingerprint"]),
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
							h.span([h.Class("code-block-lang")], ["~/.ssh/known_hosts"]),
							copyFieldButton(
								h,
								"what-known-hosts",
								relay.knownHostsLine,
								copiedBlock,
								"known_hosts entry"
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
						h.span([h.Class("code-block-lang")], ["Verify fingerprint"]),
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
					h.dl(
						[h.Class("what-list")],
						LOBBY_ITEMS.flatMap(([term, desc]) => [
							h.dt([], [term]),
							h.dd([], [desc]),
						])
					),
					h.div(
						[h.Class("what-verify")],
						[
							h.h3([h.Class("what-subhead")], ["Verify the host key"]),
							h.p(
								[h.Class("what-note")],
								[
									"The first time you connect, ssh asks you to confirm the server's ED25519 host key before continuing. Match it against the public key below:",
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
			h.p(
				[h.Class("g-statement")],
				[
					"A virtual tabletop without the overhead. ",
					h.span(
						[],
						[
							"No browser tabs, no downloads for players, and no accounts to set up before game night. One SSH command puts everyone at the same campaign stage and tactical board.",
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
