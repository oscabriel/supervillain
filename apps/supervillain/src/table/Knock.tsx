import type { KeyEvent, PasteEvent } from "@opentui/core";
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Match, Switch } from "solid-js";
import type { Accessor } from "solid-js";

import {
	backspace,
	clearToStart,
	deleteForward,
	deleteWordBack,
	emptyLine,
	insert,
	keyAction,
	moveEnd,
	moveHome,
	moveLeft,
	moveRight,
	NAME_PROMPT,
	submitLine,
} from "./input.ts";
import type { LineState } from "./input.ts";
import { InputLine } from "./InputLine.tsx";
import { color } from "./theme.ts";
import type { KnockStatus, KnockView } from "./view.ts";

const EDITS = new Map<string, (s: LineState) => LineState>([
	["backspace", backspace],
	["delete", deleteForward],
	["deleteWord", deleteWordBack],
	["clearToStart", clearToStart],
	["left", moveLeft],
	["right", moveRight],
	["home", moveHome],
	["end", moveEnd],
]);

export const KNOCK_INTRO =
	"This table lets players in by knocking. Pick the name the table should call you, and the GM decides.";

export const INVITE_INTRO =
	"You have an invite to this table. Pick the name the table should call you, and you sit straight down.";

export const waitingText = (name: string, me: string): string =>
	`Knocking as ${name} (key ${me})… the GM sees you at the top of their screen. Ctrl+C leaves.`;

type Naming = Extract<KnockStatus, { readonly kind: "naming" }>;

type Waiting = Extract<KnockStatus, { readonly kind: "waiting" }>;

type Turned = Extract<KnockStatus, { readonly kind: "turned" }>;

const naming = (status: KnockStatus): Naming | undefined =>
	status.kind === "naming" ? status : undefined;

const waiting = (status: KnockStatus): Waiting | undefined =>
	status.kind === "waiting" ? status : undefined;

const turned = (status: KnockStatus): Turned | undefined =>
	status.kind === "turned" ? status : undefined;

export const Knock = (props: { view: KnockView }) => {
	const { view } = props;
	const size = useTerminalDimensions();
	const [line, setLine] = createSignal<LineState>(emptyLine);
	const [said, setSaid] = createSignal<string>();
	const [sending, setSending] = createSignal(false);

	const send = async () => {
		const { line: typed, state } = submitLine(line());

		if (typed === undefined || sending()) {
			return;
		}

		setSending(true);

		const refusal = await view
			.knock(typed)
			.catch(() => "That didn't go through; try again.");

		setSending(false);

		if (refusal === undefined) {
			setLine(state);
			setSaid(undefined);
		} else {
			setSaid(refusal);
		}
	};

	useKeyboard((key: KeyEvent) => {
		const action = keyAction(key);

		if (action.kind === "none") {
			return;
		}

		key.preventDefault();

		if (
			action.kind === "leave" ||
			action.kind === "eof" ||
			action.kind === "escape"
		) {
			view.leave();

			return;
		}

		if (naming(view.status()) === undefined) {
			return;
		}

		if (action.kind === "insert") {
			setLine((s) => insert(s, action.text));

			return;
		}

		if (action.kind === "submit") {
			send().catch(() => {
				setSending(false);
			});

			return;
		}

		const edit = EDITS.get(action.kind);

		if (edit !== undefined) {
			setLine(edit);
		}
	});

	usePaste((event: PasteEvent) => {
		event.preventDefault();

		if (naming(view.status()) !== undefined) {
			setLine((s) => insert(s, decodePasteBytes(event.bytes)));
		}
	});

	const width = () => Math.max(20, size().width - 4);

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text wrapMode="none" truncate>
					<span style={{ fg: color.brand, bold: true }}>supervillain</span>
					<span style={{ fg: color.dim }}>{" · "}</span>
					<span style={{ fg: color.bright, bold: true }}>{view.room}</span>
					<span style={{ fg: color.dim }}>{" · at the door"}</span>
				</text>
			</box>
			<box
				flexDirection="column"
				flexGrow={1}
				paddingLeft={2}
				paddingRight={2}
				paddingTop={1}
			>
				<Switch>
					<Match when={naming(view.status())}>
						{(status: Accessor<Naming>) => (
							<box flexDirection="column" width={width()}>
								<text fg={color.text}>
									{status().invited ? INVITE_INTRO : KNOCK_INTRO}
								</text>
								<text fg={color.dim}>{`Your key: ${view.me}`}</text>
								<text fg={color.notice}>{said() ?? status().said ?? ""}</text>
							</box>
						)}
					</Match>
					<Match when={waiting(view.status())}>
						{(status: Accessor<Waiting>) => (
							<text
								fg={color.gm}
							>{`⚑ ${waitingText(status().name, view.me)}`}</text>
						)}
					</Match>
					<Match when={turned(view.status())}>
						{(status: Accessor<Turned>) => (
							<text fg={color.notice}>{status().text}</text>
						)}
					</Match>
				</Switch>
			</box>
			<InputLine
				prompt={naming(view.status()) === undefined ? "  " : `${NAME_PROMPT} `}
				line={line()}
				width={size().width}
				placeholder={false}
			/>
		</box>
	);
};
