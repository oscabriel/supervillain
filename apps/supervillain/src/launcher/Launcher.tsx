import { createCliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { RULESET_NAMES } from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";
import { Function, Option } from "effect";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { keyAction } from "../table/input.ts";
import type { KeyAction } from "../table/input.ts";
import { color } from "../table/theme.ts";
import type { FoundCampaign } from "./scan.ts";
import {
	newWizard,
	tableSlug,
	wizardHandleProblem,
	wizardKey,
} from "./wizard.ts";
import type { NewTable, Wizard, WizardKey } from "./wizard.ts";

export interface LauncherProps {
	readonly campaigns: ReadonlyArray<FoundCampaign>;
	readonly home: string;
	readonly handle: string | undefined;
	readonly relay: string | undefined;
	readonly done: (choice: LauncherChoice) => void;
}

export type LauncherChoice =
	| {
			readonly kind: "open";
			readonly dir: string;
			readonly handle: string | undefined;
	  }
	| { readonly kind: "new"; readonly table: NewTable }
	| { readonly kind: "quit" };

type Mode =
	| { readonly kind: "list" }
	| { readonly kind: "wizard"; readonly wizard: Wizard }
	| {
			readonly kind: "handle";
			readonly dir: string;
			readonly typed: string;
			readonly said: string | undefined;
	  };

const wizardKeyOf = (action: KeyAction): WizardKey | undefined => {
	if (action.kind === "insert") {
		return { kind: "char", char: action.text };
	}

	if (action.kind === "backspace") {
		return { kind: "back" };
	}

	if (action.kind === "submit") {
		return { kind: "enter" };
	}

	if (action.kind === "left" || action.kind === "right") {
		return { kind: action.kind };
	}

	return action.kind === "escape" ? { kind: "escape" } : undefined;
};

const ago = (date: Date, now: number): string => {
	const minutes = Math.round((now - date.getTime()) / 60_000);

	if (minutes < 60) {
		return minutes <= 1 ? "just now" : `${minutes} min ago`;
	}

	const hours = Math.round(minutes / 60);

	if (hours < 48) {
		return `${hours} h ago`;
	}

	return `${Math.round(hours / 24)} days ago`;
};

export const playedText = (found: FoundCampaign, now: number): string =>
	Option.match(found.lastPlayed, {
		onNone: () => "never played",
		onSome: (date) => `played ${ago(date, now)}`,
	});

const RULE_TEXT = {
	"draw-steel": "Draw Steel",
	"set-world": "set.world",
	pf2e: "PF2e (ORC)",
	freeform: "freeform",
} satisfies Record<RulesetName, string>;

const field = (label: string, value: string, on: boolean) => (
	<text>
		<span style={{ fg: on ? color.brand : color.dim }}>{on ? "› " : "  "}</span>
		<span style={{ fg: color.dim }}>{label.padEnd(10)}</span>
		<span style={{ fg: on ? color.bright : color.text, bold: on }}>
			{value}
		</span>
	</text>
);

const WizardPane = (props: { wizard: Wizard; home: string }) => {
	const w = () => props.wizard;

	const rules = () =>
		RULESET_NAMES.map((name) =>
			name === w().rules ? `‹ ${name} ›` : name
		).join("  ");

	return (
		<box flexDirection="column">
			<text fg={color.bright}>
				<span style={{ bold: true }}>New table</span>
			</text>
			<text fg={color.dim}>{`It goes in ${props.home}/<name>.`}</text>
			<text> </text>
			{field(
				"name",
				w().name === "" ? "…" : `${w().name}  (${tableSlug(w().name) || "?"})`,
				w().step === "name"
			)}
			{field(
				"rules",
				w().step === "rules" ? rules() : w().rules,
				w().step === "rules"
			)}
			<Show when={w().rules === "draw-steel"}>
				{field(
					"sample",
					w().example
						? "yes: four heroes, the bandits and a map"
						: "no: an empty campaign",
					w().step === "example"
				)}
			</Show>
			<Show when={w().askHandle}>
				{field(
					"handle",
					w().handle === "" ? "…" : w().handle,
					w().step === "handle"
				)}
			</Show>
			<text> </text>
			<text fg={color.notice}>{w().said ?? ""}</text>
		</box>
	);
};

export const Launcher = (props: LauncherProps) => {
	const [picked, setPicked] = createSignal(0);
	const [mode, setMode] = createSignal<Mode>({ kind: "list" });
	const now = Date.now();
	const count = () => props.campaigns.length;

	const open = (found: FoundCampaign) => {
		if (props.relay !== undefined && props.handle === undefined) {
			setMode({ kind: "handle", dir: found.dir, typed: "", said: undefined });

			return;
		}

		props.done({ kind: "open", dir: found.dir, handle: props.handle });
	};

	const onList = (action: KeyAction, name: string) => {
		if (action.kind === "historyUp") {
			setPicked((at) => (count() === 0 ? 0 : (at - 1 + count()) % count()));

			return;
		}

		if (action.kind === "historyDown") {
			setPicked((at) => (count() === 0 ? 0 : (at + 1) % count()));

			return;
		}

		if (action.kind === "submit") {
			const found = props.campaigns[picked()];

			if (found === undefined) {
				setMode({
					kind: "wizard",
					wizard: newWizard(
						props.relay !== undefined && props.handle === undefined
					),
				});
			} else {
				open(found);
			}

			return;
		}

		if (name === "n") {
			setMode({
				kind: "wizard",
				wizard: newWizard(
					props.relay !== undefined && props.handle === undefined
				),
			});

			return;
		}

		if (name === "q" || action.kind === "escape") {
			props.done({ kind: "quit" });
		}
	};

	const onHandle = (
		asking: Extract<Mode, { readonly kind: "handle" }>,
		action: KeyAction
	) => {
		if (action.kind === "escape") {
			setMode({ kind: "list" });

			return;
		}

		if (action.kind === "insert") {
			const typed = `${asking.typed}${action.text.toLowerCase()}`.replaceAll(
				/[^a-z0-9-]/gu,
				""
			);

			setMode({ ...asking, typed: typed.slice(0, 24), said: undefined });

			return;
		}

		if (action.kind === "backspace") {
			setMode({ ...asking, typed: asking.typed.slice(0, -1), said: undefined });

			return;
		}

		if (action.kind === "submit") {
			const problem = wizardHandleProblem(asking.typed);

			if (problem === undefined) {
				props.done({ kind: "open", dir: asking.dir, handle: asking.typed });
			} else {
				setMode({ ...asking, said: problem });
			}
		}
	};

	useKeyboard((key: KeyEvent) => {
		const action = keyAction(key);
		key.preventDefault();

		if (action.kind === "leave" || action.kind === "eof") {
			props.done({ kind: "quit" });

			return;
		}

		const current = mode();

		if (current.kind === "list") {
			onList(action, key.name);

			return;
		}

		if (current.kind === "handle") {
			onHandle(current, action);

			return;
		}

		const typed = wizardKeyOf(action);

		if (typed === undefined) {
			return;
		}

		const outcome = wizardKey(current.wizard, typed);

		if (outcome.kind === "cancelled") {
			setMode({ kind: "list" });
		} else if (outcome.kind === "done") {
			props.done({ kind: "new", table: outcome.table });
		} else {
			setMode({ kind: "wizard", wizard: outcome.wizard });
		}
	});

	const footer = () => {
		const current = mode();

		if (current.kind === "list") {
			return "↑/↓ pick · Enter open · N new table · Q quit";
		}

		return current.kind === "handle"
			? "a-z handle · Enter open · Esc back"
			: "Enter next · ←/→ change · Esc back · Ctrl-C quit";
	};

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
		>
			<text>
				<span style={{ fg: color.brand, bold: true }}>supervillain</span>
				<span style={{ fg: color.dim }}>{" · your tables"}</span>
				<span style={{ fg: color.dim }}>
					{props.relay === undefined
						? " · local only"
						: ` · players join through ${props.relay}`}
				</span>
			</text>
			<text> </text>
			<box flexDirection="column" flexGrow={1}>
				<Switch>
					<Match when={mode().kind === "list"}>
						<Show
							when={count() > 0}
							fallback={
								<box flexDirection="column">
									<text fg={color.text}>No tables yet.</text>
									<text fg={color.dim}>
										{`Press N to make one in ${props.home}.`}
									</text>
								</box>
							}
						>
							<For each={[...props.campaigns]}>
								{(found, at) => (
									<text>
										<span
											style={{
												fg: at() === picked() ? color.cursorFg : color.bright,
												bg: at() === picked() ? color.brand : undefined,
												bold: at() === picked(),
											}}
										>
											{` ${found.name.padEnd(24)} `}
										</span>
										<span style={{ fg: color.text }}>
											{`  ${RULE_TEXT[found.rules].padEnd(12)}`}
										</span>
										<span style={{ fg: color.dim }}>
											{`  ${playedText(found, now)}${found.here ? " · here" : ""}`}
										</span>
									</text>
								)}
							</For>
						</Show>
					</Match>
					<Match when={mode().kind === "wizard"}>
						<Show
							when={(() => {
								const current = mode();

								return current.kind === "wizard" ? current.wizard : undefined;
							})()}
						>
							{(wizard) => <WizardPane wizard={wizard()} home={props.home} />}
						</Show>
					</Match>
					<Match when={mode().kind === "handle"}>
						<box flexDirection="column">
							<text fg={color.bright}>Your GM handle</text>
							<text fg={color.dim}>
								Players type it before your table's name: ssh
								&lt;handle&gt;/&lt;table&gt;@…
							</text>
							<text> </text>
							<text>
								<span style={{ fg: color.brand }}>{"› "}</span>
								<span style={{ fg: color.bright, bold: true }}>
									{(() => {
										const current = mode();

										return current.kind === "handle" && current.typed !== ""
											? current.typed
											: "…";
									})()}
								</span>
							</text>
							<text fg={color.notice}>
								{(() => {
									const current = mode();

									return current.kind === "handle" ? (current.said ?? "") : "";
								})()}
							</text>
						</box>
					</Match>
				</Switch>
			</box>
			<text fg={color.dim}>{footer()}</text>
		</box>
	);
};

export const runLauncher = async (
	props: Omit<LauncherProps, "done">
): Promise<LauncherChoice> => {
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		exitSignals: [],
		enableMouseMovement: false,
		autoFocus: false,
		openConsoleOnError: false,
	});

	const { promise, resolve } = Promise.withResolvers<LauncherChoice>();

	void render(() => <Launcher {...props} done={resolve} />, renderer);

	const chosen = await promise;

	renderer.destroy();
	await renderer.closed.catch(Function.constVoid);

	return chosen;
};
