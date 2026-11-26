import {
	flushEscape,
	isEnter,
	isErase,
	LOWER_E,
	LOWER_J,
	LOWER_K,
	movePick,
	navKeyed,
	SLASH,
	SPACE,
	TILDE,
} from "../chrome/keys.ts";
import type { NavRules, NavState, Side } from "../chrome/keys.ts";
import type { NavTab } from "../chrome/tabs.ts";
import type { FoundCampaign } from "./scan.ts";
import { newWizard, wizardHandleProblem, wizardKey } from "./wizard.ts";
import type { NewTable, Wizard, WizardKey } from "./wizard.ts";

export type LauncherChoice =
	| {
			readonly kind: "open";
			readonly dir: string;
			readonly handle: string | undefined;
	  }
	| { readonly kind: "new"; readonly table: NewTable }
	| { readonly kind: "try" }
	| { readonly kind: "quit" };

export interface Launching extends NavState {
	handleFor: string | undefined;
	typedHandle: string;
	wizard: Wizard;
}

export type LauncherStep =
	| { readonly kind: "more" }
	| { readonly kind: "done"; readonly choice: LauncherChoice };

const MORE: LauncherStep = { kind: "more" };

const QUIT: LauncherStep = { kind: "done", choice: { kind: "quit" } };

const LOWER_N = 0x6e;

const HANDLE_MAX = 24;

export const launching = (askHandle: boolean): Launching => ({
	tab: "tables",
	picked: 0,
	editing: false,
	handleFor: undefined,
	typedHandle: "",
	wizard: newWizard(askHandle),
	said: undefined,
	escape: "no",
	sequence: "",
	afterCr: false,
});

const switchTab = (state: Launching, tab: NavTab) => {
	if (state.tab === tab) {
		return;
	}

	state.tab = tab;
	state.editing = false;
	state.handleFor = undefined;
	state.typedHandle = "";
	state.said = undefined;
	state.wizard = { ...state.wizard, said: undefined };
};

const isWizardChoiceStep = (wizard: Wizard): boolean =>
	wizard.step === "rules" || wizard.step === "example";

const stepWizard = (state: Launching, key: WizardKey): LauncherStep => {
	const outcome = wizardKey(state.wizard, key);

	if (outcome.kind === "done") {
		return { kind: "done", choice: { kind: "new", table: outcome.table } };
	}

	if (outcome.kind === "cancelled") {
		state.editing = false;
		state.wizard = { ...state.wizard, said: undefined };

		return MORE;
	}

	state.wizard = outcome.wizard;

	return MORE;
};

const backOut = (state: Launching): boolean => {
	if (state.tab === "tables" && state.editing) {
		state.editing = false;
		state.handleFor = undefined;
		state.typedHandle = "";
		state.said = undefined;

		return true;
	}

	if (state.tab === "create" && state.editing) {
		stepWizard(state, { kind: "escape" });

		return true;
	}

	if (state.said !== undefined || state.wizard.said !== undefined) {
		state.said = undefined;
		state.wizard = { ...state.wizard, said: undefined };

		return true;
	}

	return false;
};

const sideways = (state: Launching, side: Side): boolean => {
	if (state.tab !== "create" || !isWizardChoiceStep(state.wizard)) {
		return false;
	}

	stepWizard(state, { kind: side });

	return true;
};

export const LAUNCHER_NAV: NavRules<Launching> = {
	switchTab,
	backOut,
	sideways,
};

export const flushLauncherEscape = (state: Launching): boolean =>
	flushEscape(LAUNCHER_NAV, state);

const openCreateEditing = (state: Launching, askHandle: boolean) => {
	state.tab = "create";
	state.editing = true;
	state.handleFor = undefined;
	state.typedHandle = "";
	state.said = undefined;
	state.wizard = newWizard(askHandle);
};

const onHandleEdit = (state: Launching, byte: number): LauncherStep => {
	if (isEnter(byte)) {
		const problem = wizardHandleProblem(state.typedHandle);

		if (problem === undefined && state.handleFor !== undefined) {
			return {
				kind: "done",
				choice: {
					kind: "open",
					dir: state.handleFor,
					handle: state.typedHandle,
				},
			};
		}

		state.said = problem;

		return MORE;
	}

	if (isErase(byte)) {
		state.typedHandle = state.typedHandle.slice(0, -1);
		state.said = undefined;

		return MORE;
	}

	if (byte >= SPACE && byte <= TILDE) {
		const ch = String.fromCodePoint(byte).toLowerCase();

		if (/^[a-z0-9-]$/u.test(ch) && state.typedHandle.length < HANDLE_MAX) {
			state.typedHandle += ch;
			state.said = undefined;
		}
	}

	return MORE;
};

const onTables = (
	state: Launching,
	campaigns: ReadonlyArray<FoundCampaign>,
	relay: string | undefined,
	handle: string | undefined,
	byte: number
): LauncherStep => {
	if (state.editing) {
		return onHandleEdit(state, byte);
	}

	if (byte === LOWER_J) {
		movePick(state, 1, campaigns.length);

		return MORE;
	}

	if (byte === LOWER_K) {
		movePick(state, -1, campaigns.length);

		return MORE;
	}

	const askHandle = relay !== undefined && handle === undefined;

	if (byte === LOWER_N) {
		openCreateEditing(state, askHandle);

		return MORE;
	}

	if (isEnter(byte)) {
		const found = campaigns[state.picked];

		if (found === undefined) {
			openCreateEditing(state, askHandle);

			return MORE;
		}

		if (askHandle) {
			state.editing = true;
			state.handleFor = found.dir;
			state.typedHandle = "";
			state.said = undefined;

			return MORE;
		}

		return {
			kind: "done",
			choice: { kind: "open", dir: found.dir, handle },
		};
	}

	return MORE;
};

const onCreate = (state: Launching, byte: number): LauncherStep => {
	if (state.editing) {
		if (isEnter(byte)) {
			return stepWizard(state, { kind: "enter" });
		}

		if (isErase(byte)) {
			return stepWizard(state, { kind: "back" });
		}

		if (byte >= SPACE && byte <= TILDE) {
			return stepWizard(state, {
				kind: "char",
				char: String.fromCodePoint(byte),
			});
		}

		return MORE;
	}

	if (byte === SLASH || byte === LOWER_E) {
		state.editing = true;
		state.wizard = { ...state.wizard, said: undefined };

		return MORE;
	}

	if (isEnter(byte)) {
		if (state.wizard.step === "name" && state.wizard.name === "") {
			state.editing = true;
			state.wizard = { ...state.wizard, said: undefined };

			return MORE;
		}

		if (state.wizard.step === "handle" && state.wizard.handle === "") {
			state.editing = true;
			state.wizard = { ...state.wizard, said: undefined };

			return MORE;
		}

		const next = stepWizard(state, { kind: "enter" });

		if (next.kind === "more") {
			state.editing = true;
		}

		return next;
	}

	return MORE;
};

export const launcherKeyed = (
	state: Launching,
	campaigns: ReadonlyArray<FoundCampaign>,
	relay: string | undefined,
	handle: string | undefined,
	byte: number
): LauncherStep => {
	const nav = navKeyed(LAUNCHER_NAV, state, byte, campaigns.length);

	if (nav === "quit") {
		return QUIT;
	}

	if (nav === "handled") {
		return MORE;
	}

	if (state.tab === "tables") {
		return onTables(state, campaigns, relay, handle, byte);
	}

	if (state.tab === "create") {
		return onCreate(state, byte);
	}

	return state.tab === "try" && isEnter(byte)
		? { kind: "done", choice: { kind: "try" } }
		: MORE;
};
