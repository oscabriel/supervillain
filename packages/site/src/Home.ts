import type { Html, HtmlBuilder } from "foldkit/html";

import { HeroWaves } from "./HeroWaves.ts";
import { Message } from "./Model.ts";
import type { Model } from "./Model.ts";
import { terminalView } from "./Terminal.ts";

export const JOIN_COMMAND = "ssh supervillain.sh";

const ROWS: ReadonlyArray<readonly [string, string, string]> = [
	[
		"Zero friction at game night",
		"Your players already have OpenSSH. Share one room address and everyone drops straight into the session from their terminal, with nothing to install and nothing to sign up for.",
		"ssh room@supervillain.sh",
	],
	[
		"Tactical play, right in the terminal",
		"Move tokens with mouse clicks or slash commands, roll dice, track stamina and turns, whisper to the GM, and view pixel-art maps or crisp text on any terminal.",
		"/move · /pr · /roll",
	],
	[
		"Your machine is the table",
		"The GM runs one small program locally. Every rule resolves on your machine, your campaign stays on your own disk, and your SSH key is your identity across sessions.",
		"supervillain host",
	],
	[
		"Three rulesets out of the box",
		"Built-in support for Draw Steel, set.world, and PF2e Remaster under the ORC License, complete with character sheets, abilities, and encounter flow.",
		"Draw Steel · set.world · PF2e",
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
							"No browser tabs, no downloads, and no accounts to set up before game night. One SSH command puts every player at the same live tactical board.",
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
