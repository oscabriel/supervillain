import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Model.ts";
import type { Model } from "./Model.ts";
import { blogRouter, docRouter, docsRouter } from "./Route.ts";
import { terminalView } from "./Terminal.ts";

export const JOIN_COMMAND = "ssh first-fight@table.example.com";

const HOSTING = docRouter({ slug: "hosting" });

const PLAYING = docRouter({ slug: "playing" });

const RULESETS = docRouter({ slug: "rulesets" });

const ARCHITECTURE = docRouter({ slug: "architecture" });

const TABLE: ReadonlyArray<readonly [string, string]> = [
	[
		"Nothing to install",
		"Players need an OpenSSH client, which macOS, Linux and Windows 10 and later already have. They paste one command and sit down.",
	],
	[
		"Your key is who you are",
		"There are no accounts. A player's SSH key is their identity, and the table remembers their name and hero for it. A client with no key comes in as a guest.",
	],
	[
		"The GM's machine is the table",
		"It runs the rules, draws every player's screen and keeps the campaign. Players send keystrokes and get frames back; nothing runs on their side.",
	],
	[
		"The campaign is a text file",
		"Every change is one JSON line appended to events.jsonl on the GM's disk. Replay never rolls dice and never reads a file, so the log alone rebuilds the table.",
	],
	[
		"Reach it from anywhere",
		"Listen on a LAN or a tailnet, tunnel it, or dial out to a small relay so players get a permanent address while your machine opens no port.",
	],
	[
		"Type it or click it",
		"Plain text is chat and / starts a command. A click on a token opens a menu that sends the very line you could have typed, so the mouse teaches the commands.",
	],
];

interface Ruleset {
	readonly name: string;
	readonly key: string;
	readonly state: string;
	readonly tone: string;
	readonly about: string;
}

const RULES: ReadonlyArray<Ruleset> = [
	{
		name: "Draw Steel",
		key: "rules: draw-steel",
		state: "playable",
		tone: "ready",
		about:
			"MCDM's tactical fantasy game: heroes from sheets, monsters from stat blocks, power rolls with tiers, turn action budgets, Stamina, conditions, heroic resources, Malice, forced movement and multi-square footprints. The default for a new campaign.",
	},
	{
		name: "set.world",
		key: "rules: set-world",
		state: "playable",
		tone: "ready",
		about:
			"Fighters rolled from a seed at set.world, turns by initiative on a logical clock instead of rounds, Set's stamina, dodge and critical hits, and optional /auto foes on the same grid.",
	},
	{
		name: "PF2e Remaster (ORC)",
		key: "rules: pf2e",
		state: "playable",
		tone: "ready",
		about:
			"Open Remaster tactical combat under the ORC licence: three actions and a reaction per turn, four degrees of success, alternating diagonals, Shield Block, Hero Points, Elite/Weak templates and Pathbuilder import.",
	},
];

const FIGURES: ReadonlyArray<readonly [string, string]> = [
	["0", "programs a player installs, and accounts anyone makes"],
	["1", "binary for the GM: host, relay and tools, on Linux and macOS"],
	["1", "append-only file holds the whole campaign"],
];

const BUILT: ReadonlyArray<readonly [string, string]> = [
	[
		"Pure rules, Effect at the edge",
		"decide(state, actor, command, dice) returns events or a refusal, and apply folds one event. No clock, I/O or randomness in the rules; Effect 4 owns the log file, the single writer and every session's lifetime.",
	],
	[
		"A domain model over a JSONL file",
		"The table is an @alchemy.run/domain aggregate. Its storage is one events.jsonl, written by a single writer that halts on an event it can't apply rather than guess.",
	],
	[
		"SSH that expects strangers",
		"Our own server on ssh2, offering only elliptic-curve key exchange with ML-KEM's post-quantum hybrid first. It caps connections and sessions per address, times out logins and cuts peers that stop reading.",
	],
	[
		"One app, every seat",
		"The GM's terminal and each SSH seat run the same Solid app on OpenTUI, drawn from a read-only view of the table. Kitty-graphics terminals can show the map as pictures.",
	],
];

const pairsView = (
	pairs: ReadonlyArray<readonly [string, string]>,
	h: HtmlBuilder<Message>
): Html =>
	h.dl(
		[h.Class("pairs")],
		pairs.map(([term, means]) =>
			h.div([], [h.dt([], [term]), h.dd([], [means])])
		)
	);

const rulesView = (h: HtmlBuilder<Message>): Html =>
	h.ul(
		[h.Class("rules")],
		RULES.map((ruleset) =>
			h.li(
				[h.DataAttribute("tone", ruleset.tone)],
				[
					h.div(
						[h.Class("rules-head")],
						[
							h.h3([], [ruleset.name]),
							h.span([h.Class("rules-state")], [ruleset.state]),
						]
					),
					h.p([h.Class("rules-key")], [ruleset.key]),
					h.p([h.Class("rules-about")], [ruleset.about]),
				]
			)
		)
	);

const copyCommandView = (copied: boolean, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("shell-bar")],
		[
			h.pre(
				[h.Class("shell")],
				[
					h.code(
						[],
						[
							h.span([h.Class("shell-prompt")], ["$ "]),
							"ssh ",
							h.span([h.Class("shell-room")], ["first-fight"]),
							"@",
							h.span([h.Class("shell-host")], ["table.example.com"]),
						]
					),
				]
			),
			h.button(
				[
					h.Type("button"),
					h.Class("copy-btn"),
					h.DataAttribute("copied", copied ? "true" : "false"),
					h.AriaLabel(copied ? "Copied command" : "Copy ssh command"),
					h.OnClick(Message.ClickedCopyCommand()),
				],
				[
					h.span(
						[h.Class("copy-label copy-idle"), h.AriaHidden(copied)],
						["copy"]
					),
					h.span(
						[h.Class("copy-label copy-done"), h.AriaHidden(!copied)],
						["copied ✓"]
					),
				]
			),
		]
	);

export const homeView = (
	model: Model,
	h: HtmlBuilder<Message>
): ReadonlyArray<Html> => [
	h.section(
		[h.Class("hero")],
		[
			h.p(
				[h.Class("label hero-eyebrow")],
				["terminal-first · open source · MIT"]
			),
			h.h1([h.Class("hero-title")], ["A virtual tabletop you join with ssh."]),
			h.p(
				[h.Class("lede hero-lede")],
				[
					"Players type one command and are sitting at a live table, with nothing to install and no account to make. The GM's machine runs the rules, draws every screen and keeps the campaign as a plain append-only log on the GM's disk.",
				]
			),
			h.div(
				[h.Class("hero-actions")],
				[
					copyCommandView(model.copied, h),
					h.p(
						[h.Class("calls")],
						[
							h.a([h.Href(HOSTING), h.Class("call")], ["Host a table"]),
							h.a(
								[h.Href("#table"), h.Class("call-link")],
								["Try the table below ", h.span([h.Class("arrow")], ["↓"])]
							),
							h.a(
								[h.Href(PLAYING), h.Class("call-link")],
								["Send this to players ", h.span([h.Class("arrow")], ["→"])]
							),
						]
					),
				]
			),
		]
	),
	terminalView(model.demo, h),
	h.section(
		[h.Class("band")],
		[h.h2([], ["How a table works"]), pairsView(TABLE, h)]
	),
	h.section(
		[h.Class("band")],
		[
			h.h2([], ["Three rulesets, one log"]),
			h.p(
				[h.Class("lede")],
				[
					"A campaign names its ruleset in campaign.yaml. The ruleset decides which commands the table offers and what the band, the map and /sheet show; chat, names, dice and /undo work the same everywhere.",
				]
			),
			rulesView(h),
			h.p(
				[],
				[
					h.a(
						[h.Href(RULESETS), h.Class("call-link")],
						["Read about the rulesets ", h.span([h.Class("arrow")], ["→"])]
					),
				]
			),
		]
	),
	h.section(
		[h.Class("band")],
		[
			h.h2([], ["Small on purpose"]),
			h.dl(
				[h.Class("figures")],
				FIGURES.map(([figure, means]) =>
					h.div([], [h.dt([], [figure]), h.dd([], [means])])
				)
			),
			pairsView(BUILT, h),
			h.p(
				[h.Class("calls")],
				[
					h.a(
						[h.Href(ARCHITECTURE), h.Class("call-link")],
						["How it fits together ", h.span([h.Class("arrow")], ["→"])]
					),
					h.a(
						[h.Href(docsRouter()), h.Class("call-link")],
						["All the docs ", h.span([h.Class("arrow")], ["→"])]
					),
					h.a(
						[h.Href(blogRouter()), h.Class("call-link")],
						["The blog ", h.span([h.Class("arrow")], ["→"])]
					),
				]
			),
		]
	),
];
