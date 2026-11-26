import {
	cut,
	field,
	fitRow,
	heading,
	hint,
	layoutStage,
	renderFrame,
	width,
	words,
} from "../../chrome/frame.ts";
import type { BodyView, Row, Seg } from "../../chrome/frame.ts";
import {
	enterPill,
	footerRow,
	gettingStarted,
	inlineInputField,
	NAV_HINTS,
	pickList,
	rulesetsField,
	rulesRow,
	sandboxBody,
	sessionBody,
	sessionLead,
	stepsRow,
	tablesBody,
} from "../../chrome/panes.ts";
import type {
	InputRow,
	SandboxNeeds,
	SessionPanes,
	TablePanes,
} from "../../chrome/panes.ts";
import type { NavTab } from "../../chrome/tabs.ts";
import { color } from "../../table/theme.ts";
import { HANDLE_RULE } from "../protocol.ts";
import { commandsOf, createForm, KEYLESS_CREATE } from "./create.ts";
import type { CreateForm, CreateStep } from "./create.ts";

export interface LobbyTable {
	readonly handle: string;
	readonly table: string;
	readonly seated: number;
}

export const tableAddress = (table: LobbyTable): string =>
	`${table.handle}/${table.table}`;

export interface SandboxNote {
	readonly open: boolean;
	readonly cols: number;
	readonly rows: number;
	readonly idleMinutes: number;
	readonly maxMinutes: number;
}

export interface LobbyScreen {
	readonly tab?: NavTab;
	readonly editing?: boolean;
	readonly create?: CreateForm;
	readonly sandbox?: SandboxNote;
	readonly tables: ReadonlyArray<LobbyTable>;
	readonly picked: number;
	readonly typed: string;
	readonly said?: string | undefined;
	readonly you: {
		readonly key:
			| { readonly fingerprint: string; readonly algorithm: string }
			| undefined;
		readonly term: string;
	};
}

const tabOf = (screen: LobbyScreen): NavTab => screen.tab ?? "tables";

const editingOf = (screen: LobbyScreen): boolean => screen.editing === true;

const formOf = (screen: LobbyScreen): CreateForm =>
	screen.create ?? createForm(screen.you.key === undefined, undefined);

const tableInputRow = (
	typed: string,
	editing: boolean,
	w: number
): InputRow => {
	const shown = cut(typed, Math.max(1, w - 2));

	if (editing) {
		const row: Row =
			typed === ""
				? [
						{ text: "> ", fg: color.brand, bold: true },
						{ text: cut("handle/table", Math.max(1, w - 2)), fg: color.dim },
					]
				: [
						{ text: "> ", fg: color.brand, bold: true },
						{ text: shown, fg: color.bright, bold: true },
					];

		return { row, cursorCol: 2 + width(shown) };
	}

	return { row: enterPill("join by name"), cursorCol: 0 };
};

const emptyLobby = (screen: LobbyScreen, w: number): BodyView => {
	const guest = screen.you.key === undefined;
	const editing = editingOf(screen);
	const input = tableInputRow(screen.typed, editing, w);

	if (editing) {
		const rows: Array<Row> = [
			heading("join by table name", w, color.bright),
			[],
			...words(
				"Enter the address your GM gave you, like ana/first-fight.",
				color.dim,
				w
			),
			[],
		];

		const inputRowIndex = rows.length;
		rows.push(input.row);

		return {
			rows,
			cursor: { row: inputRowIndex, col: input.cursorCol },
		};
	}

	const status: Row = guest
		? [
				{ text: "○ ", fg: color.gm },
				{ text: cut("guest session · no saved tables", w - 2), fg: color.text },
			]
		: [
				{ text: "○ ", fg: color.dim },
				{ text: cut("no open tables yet", w - 2), fg: color.text },
			];

	const note = guest
		? "Add an SSH key so tables remember your seat. You can still join any table by name."
		: "Tables you've played at appear here whenever their GM is live.";

	return {
		rows: [
			heading("join a table", w),
			status,
			[],
			...words(note, color.dim, w),
			[],
			input.row,
		],
	};
};

const startedOrDirect = (screen: LobbyScreen, w: number): Array<Row> => {
	if (!editingOf(screen)) {
		return gettingStarted(
			"Claim a GM handle and host campaigns from your machine.",
			w
		);
	}

	const target = screen.typed === "" ? "<handle>/<table>" : screen.typed;

	return [
		heading("direct command", w),
		[{ text: cut(`ssh ${target}@…`, w), fg: color.dice }],
		[],
		...words(
			"Short names (just the table) work once a table knows your key.",
			color.dim,
			w
		),
	];
};

const openTableList = (
	screen: LobbyScreen,
	w: number,
	maxItems: number
): Array<Row> =>
	pickList(
		{
			title: "open tables",
			items: screen.tables.map((t) => ({
				name: tableAddress(t),
				badge: `${t.seated > 0 ? "●" : "○"} ${t.seated}`,
				lit: t.seated > 0,
			})),
			picked: screen.picked,
			editing: editingOf(screen),
			other: "+ join another table…",
			otherEdited: editingOf(screen),
		},
		w,
		maxItems
	);

const openTableDetail = (screen: LobbyScreen, w: number): BodyView => {
	const editing = editingOf(screen);
	const current = screen.tables[screen.picked];

	if (editing) {
		const title = screen.typed === "" ? "join another table" : screen.typed;
		const input = tableInputRow(screen.typed, true, w);

		const rows: Array<Row> = [
			heading(title, w, color.bright),
			[
				{ text: "◈ ", fg: color.brand },
				{ text: cut("joining by table name", w - 2), fg: color.text },
			],
			[],
		];

		const inputRowIndex = rows.length;

		rows.push(
			input.row,
			[],
			field("direct", [
				{
					text: cut(
						`ssh ${screen.typed === "" ? "<handle>/<table>" : screen.typed}@…`,
						w - 10
					),
					fg: color.dice,
				},
			])
		);

		return {
			rows,
			cursor: { row: inputRowIndex, col: input.cursorCol },
		};
	}

	if (current !== undefined) {
		const live: Row =
			current.seated > 0
				? [
						{ text: `● ${current.seated} seated`, fg: color.healthy },
						{ text: " · open now", fg: color.dim },
					]
				: [
						{ text: "○ empty", fg: color.dim },
						{ text: " · open now", fg: color.dim },
					];

		return {
			rows: [
				heading(tableAddress(current), w, color.bright),
				live,
				[],
				enterPill("sit down"),
				[],
				field("direct", [
					{
						text: cut(`ssh ${tableAddress(current)}@…`, w - 10),
						fg: color.dice,
					},
				]),
			],
		};
	}

	return {
		rows: [
			heading("join another table", w, color.bright),
			...words(
				"Type any table's <handle>/<table> address to sit down at a table not listed here.",
				color.dim,
				w
			),
			[],
			enterPill("type a name"),
		],
	};
};

const tablePanes = (screen: LobbyScreen): TablePanes => ({
	count: screen.tables.length,
	editing: editingOf(screen),
	empty: (w) => emptyLobby(screen, w),
	started: (w) => startedOrDirect(screen, w),
	list: (w, maxItems) => openTableList(screen, w, maxItems),
	detail: (w) => openTableDetail(screen, w),
});

const sandboxNeeds = (sandbox: SandboxNote): SandboxNeeds => ({
	cols: sandbox.cols,
	rows: sandbox.rows,
	note: (colW) =>
		field("closes", [
			{
				text: cut(
					`${sandbox.idleMinutes} min idle · ${sandbox.maxMinutes} min max`,
					colW - 10
				),
				fg: color.text,
			},
		]),
});

const tryBody = (
	screen: LobbyScreen,
	w: number,
	cols: number,
	rows: number
): BodyView => {
	const { sandbox } = screen;

	const action: Row =
		sandbox?.open === true
			? enterPill("start sandbox")
			: [
					{ text: "○ ", fg: color.dim },
					{
						text: cut("this relay offers no sandbox tables", w - 2),
						fg: color.dim,
					},
				];

	return sandboxBody(
		action,
		sandbox === undefined ? undefined : sandboxNeeds(sandbox),
		w,
		cols,
		rows
	);
};

const CREATE_STEPS: ReadonlyArray<readonly [CreateStep, string]> = [
	["handle", "handle"],
	["table", "table & rules"],
	["ready", "ready"],
];

export const shellLines = (command: string, w: number): Array<string> => {
	if (width(command) <= w) {
		return [command];
	}

	const lines: Array<string> = [];
	let line = "";

	for (const word of command.split(" ")) {
		const room = lines.length === 0 ? w - 2 : w - 4;

		if (line !== "" && width(line) + 1 + width(word) > room) {
			lines.push(line);
			line = word;
		} else {
			line = line === "" ? word : `${line} ${word}`;
		}
	}

	lines.push(line);

	return lines.map((text, i) => {
		const lead = i === 0 ? "" : "  ";

		return i === lines.length - 1 ? `${lead}${text}` : `${lead}${text} \\`;
	});
};

const createBody = (screen: LobbyScreen, w: number): BodyView => {
	const form = formOf(screen);
	const editing = editingOf(screen);

	if (form.guest) {
		return {
			rows: [
				[
					{ text: "○ ", fg: color.gm },
					{
						text: cut("Creating a table needs an SSH key", w - 2),
						fg: color.bright,
						bold: true,
					},
				],
				[],
				...words(KEYLESS_CREATE, color.text, w),
				[],
				field("setup", [
					{ text: cut("ssh-keygen -t ed25519", w - 10), fg: color.dice },
				]),
			],
		};
	}

	const head: Array<Row> = [stepsRow(CREATE_STEPS, form.step, w), []];

	if (form.step === "handle") {
		if (form.held !== undefined) {
			return {
				rows: [
					...head,
					[
						{ text: "● ", fg: color.healthy },
						{ text: "You hold ", fg: color.text },
						{ text: cut(form.held, w - 11), fg: color.bright, bold: true },
					],
					...words(
						`Players join with ssh ${form.held}/<table>@…`,
						color.dim,
						w
					),
					[],
					enterPill("continue"),
				],
			};
		}

		const input = inlineInputField(
			"handle",
			form.handle,
			"type your handle…",
			editing,
			w
		);

		const lead: Array<Row> = [
			...head,
			...words(
				"Pick your GM handle. Players put it before your table's name, bound to this SSH key.",
				color.text,
				w
			),
			[],
		];

		const inputRowIndex = lead.length;

		const rows: Array<Row> = [
			...lead,
			input.row,
			field("format", [{ text: cut(HANDLE_RULE, w - 10), fg: color.dim }]),
		];

		if (!editing) {
			rows.push([], enterPill("set handle"));
		}

		return {
			rows,
			cursor: editing
				? { row: inputRowIndex, col: input.cursorCol }
				: undefined,
		};
	}

	if (form.step === "table" || form.ready === undefined) {
		const tableInput = inlineInputField(
			"table",
			form.table,
			"type your table's name…",
			editing,
			w
		);

		const top: Array<Row> = [
			...head,
			field("handle", [{ text: cut(form.handle, w - 10), fg: color.bright }]),
		];

		const inputRowIndex = top.length;

		return {
			rows: [
				...top,
				tableInput.row,
				fitRow(field("rules", rulesRow(form.rules, true)), w),
				[],
				...words(
					"Enter makes a one-time pairing code so your computer's GM key can host under this handle.",
					color.dim,
					w
				),
			],
			cursor: editing
				? { row: inputRowIndex, col: tableInput.cursorCol }
				: undefined,
		};
	}

	const commands = commandsOf(form, form.ready);

	const shell = [commands.install, commands.create].flatMap((command) =>
		shellLines(command, Math.max(12, w - 2)).map((line): Row => [
			{ text: `  ${line}`, fg: color.dice },
		])
	);

	return {
		rows: [
			...head,
			[
				{ text: "● ", fg: color.healthy },
				{
					text: cut("Run these on your computer", w - 2),
					fg: color.bright,
					bold: true,
				},
			],
			[],
			...shell,
			[],
			...words(
				"The code works once for 15 minutes and was copied to your clipboard if your terminal allows OSC 52.",
				color.dim,
				w
			),
			[],
			field("table", [
				{
					text: cut(`${form.handle}/${form.table} · ${form.rules}`, w - 10),
					fg: color.text,
				},
			]),
		],
	};
};

const commandRows = (colW: number): Array<Row> => [
	heading("commands", colW),
	field("direct", [
		{ text: cut("ssh <handle>/<table>@…", colW - 10), fg: color.dice },
	]),
	field("host", [
		{
			text: cut("supervillain host --handle <you> --relay", colW - 10),
			fg: color.director,
		},
	]),
	rulesetsField(colW),
];

const keyRows = (screen: LobbyScreen, colW: number): Array<Row> => {
	const yours = screen.you.key;

	if (yours === undefined) {
		return [
			heading("ssh key", colW),
			field("key", [
				{ text: "none", fg: color.gm },
				{
					text: cut(" · ephemeral seat", Math.max(0, colW - 14)),
					fg: color.dim,
				},
			]),
			field("setup", [
				{ text: cut("ssh-keygen -t ed25519", colW - 10), fg: color.dice },
			]),
		];
	}

	const algo = cut(yours.algorithm, Math.max(4, colW - 10));
	const noteSpace = colW - 10 - width(algo);
	const algoRow: Array<Seg> = [{ text: algo, fg: color.heroes }];

	if (noteSpace >= 13) {
		algoRow.push({ text: " · no account", fg: color.dim });
	}

	return [
		heading("ssh key", colW),
		field("key", algoRow),
		[{ text: cut(yours.fingerprint, colW), fg: color.bright }],
	];
};

const identityRows = (screen: LobbyScreen, colW: number): Array<Row> => {
	const yours = screen.you.key;
	const { held } = formOf(screen);

	const auth = field("auth", [
		{
			text: yours === undefined ? "guest" : "ssh key",
			fg: yours === undefined ? color.gm : color.heroes,
		},
	]);

	if (yours === undefined) {
		return [auth];
	}

	return [
		auth,
		field("handle", [
			{
				text: cut(held ?? "none claimed", colW - 10),
				fg: held === undefined ? color.dim : color.bright,
			},
		]),
	];
};

const sessionPanes = (
	screen: LobbyScreen,
	cols: number,
	rows: number
): SessionPanes => ({
	left: (colW) => [
		...sessionLead(
			{
				term: screen.you.term,
				tableCount: screen.tables.length,
				tablesAre: "open",
			},
			colW,
			cols,
			rows
		),
		...identityRows(screen, colW),
	],
	right: (colW, wide) =>
		wide
			? [...keyRows(screen, colW), [], ...commandRows(colW)]
			: keyRows(screen, colW),
});

const tableFooter = (screen: LobbyScreen): ReadonlyArray<Array<Seg>> => {
	if (editingOf(screen)) {
		return [
			hint("enter", "sit down"),
			hint("esc", "cancel"),
			hint("ctrl-c", "quit"),
		];
	}

	if (screen.tables.length === 0) {
		return [hint("enter", "join by name"), ...NAV_HINTS];
	}

	if (screen.picked >= screen.tables.length) {
		return [
			hint("↑/↓", "pick"),
			hint("enter", "join by name"),
			hint("1-4", "tabs"),
			hint("q", "quit"),
		];
	}

	return [
		hint("↑/↓", "pick"),
		hint("enter", "sit down"),
		hint("/", "join by name"),
		hint("1-4", "tabs"),
		hint("q", "quit"),
	];
};

const createFooter = (
	form: CreateForm,
	editing: boolean
): ReadonlyArray<Array<Seg>> => {
	if (form.guest) {
		return NAV_HINTS;
	}

	if (form.step === "ready") {
		return [hint("c", "copy commands"), ...NAV_HINTS];
	}

	if (form.step === "handle") {
		if (form.held !== undefined) {
			return [hint("enter", "continue"), ...NAV_HINTS];
		}

		return editing
			? [
					hint("enter", "claim handle"),
					hint("esc", "cancel"),
					hint("ctrl-c", "quit"),
				]
			: [hint("enter", "set handle"), ...NAV_HINTS];
	}

	if (editing) {
		return [
			hint("←/→", "rules"),
			hint("enter", "create code"),
			hint("esc", "cancel"),
			hint("ctrl-c", "quit"),
		];
	}

	return form.table === ""
		? [
				hint("enter", "set table"),
				hint("←/→", "rules"),
				hint("1-4", "tabs"),
				hint("q", "quit"),
			]
		: [
				hint("enter", "create code"),
				hint("e", "edit"),
				hint("←/→", "rules"),
				hint("1-4", "tabs"),
				hint("q", "quit"),
			];
};

const footerParts = (screen: LobbyScreen): ReadonlyArray<Array<Seg>> => {
	const tab = tabOf(screen);

	if (tab === "try") {
		return screen.sandbox?.open === true
			? [hint("enter", "start sandbox"), ...NAV_HINTS]
			: NAV_HINTS;
	}

	if (tab === "create") {
		return createFooter(formOf(screen), editingOf(screen));
	}

	if (tab === "session") {
		return screen.you.key === undefined
			? NAV_HINTS
			: [hint("c", "copy fingerprint"), ...NAV_HINTS];
	}

	return tableFooter(screen);
};

export const lobbyFrame = (
	screen: LobbyScreen,
	cols: number,
	rows: number
): string => {
	const tab = tabOf(screen);
	const editing = editingOf(screen);

	return renderFrame(
		layoutStage({
			active: tab,
			editing,
			tableCount: screen.tables.length,
			subtitle: "lobby",
			cols,
			rows,
			bodies: {
				tables: (w) => tablesBody(tablePanes(screen), w, rows),
				try: (w) => tryBody(screen, w, cols, rows),
				create: (w) => createBody(screen, w),
				session: (w) => sessionBody(sessionPanes(screen, cols, rows), w),
			},
			footer: (w) => footerRow(footerParts(screen), editing, "cancel", w),
			said: tab === "create" ? formOf(screen).said : screen.said,
		})
	);
};
