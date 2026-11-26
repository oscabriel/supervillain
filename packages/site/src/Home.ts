import type { Html, HtmlBuilder } from "foldkit/html";

import { HeroWaves } from "./HeroWaves.ts";
import { Message } from "./Model.ts";
import type { Model } from "./Model.ts";
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

const heroView = (copied: boolean, h: HtmlBuilder<Message>): Html =>
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
): ReadonlyArray<Html> => [
	heroView(model.copied, h),
	terminalView(model.demo, h, model.mapMode, {
		autoplay: model.autoplay,
		autoplayLine: model.autoplayLine,
	}),
	editorialView(h),
];
