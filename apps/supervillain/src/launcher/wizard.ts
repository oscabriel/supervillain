import { RULESET_NAMES } from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";

import {
	HANDLE_RULE,
	isHandle,
	isReservedHandle,
	isTableName,
} from "../relay/protocol.ts";

export type WizardStep = "name" | "rules" | "example" | "handle";

export interface Wizard {
	readonly step: WizardStep;
	readonly name: string;
	readonly rules: RulesetName;
	readonly example: boolean;
	readonly handle: string;
	readonly askHandle: boolean;
	readonly said: string | undefined;
}

export type WizardKey =
	| { readonly kind: "char"; readonly char: string }
	| { readonly kind: "back" }
	| { readonly kind: "enter" }
	| { readonly kind: "left" }
	| { readonly kind: "right" }
	| { readonly kind: "escape" };

export interface NewTable {
	readonly slug: string;
	readonly rules: RulesetName;
	readonly example: boolean;
	readonly handle: string | undefined;
}

export type WizardOutcome =
	| { readonly kind: "editing"; readonly wizard: Wizard }
	| { readonly kind: "cancelled" }
	| { readonly kind: "done"; readonly table: NewTable };

const NAME_LENGTH = 48;

const HANDLE_LENGTH = 24;

const SLUG_LENGTH = 32;

export const tableSlug = (name: string): string =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replace(/^[^a-z]+/u, "")
		.slice(0, SLUG_LENGTH)
		.replace(/-+$/u, "");

export const newWizard = (askHandle: boolean): Wizard => ({
	step: "name",
	name: "",
	rules: "draw-steel",
	example: true,
	handle: "",
	askHandle,
	said: undefined,
});

const editing = (wizard: Wizard): WizardOutcome => ({
	kind: "editing",
	wizard,
});

const stepsOf = (wizard: Wizard): ReadonlyArray<WizardStep> => {
	const steps: Array<WizardStep> = ["name", "rules"];

	if (wizard.rules === "draw-steel") {
		steps.push("example");
	}

	if (wizard.askHandle) {
		steps.push("handle");
	}

	return steps;
};

const finished = (wizard: Wizard): NewTable => ({
	slug: tableSlug(wizard.name),
	rules: wizard.rules,
	example: wizard.rules === "draw-steel" && wizard.example,
	handle: wizard.askHandle ? wizard.handle : undefined,
});

const moveOn = (wizard: Wizard): WizardOutcome => {
	const steps = stepsOf(wizard);
	const next = steps[steps.indexOf(wizard.step) + 1];

	return next === undefined
		? { kind: "done", table: finished(wizard) }
		: editing({ ...wizard, step: next, said: undefined });
};

const goBack = (wizard: Wizard): WizardOutcome => {
	const steps = stepsOf(wizard);
	const before = steps[steps.indexOf(wizard.step) - 1];

	return before === undefined
		? { kind: "cancelled" }
		: editing({ ...wizard, step: before, said: undefined });
};

export const nameProblem = (name: string): string | undefined => {
	if (name.trim() === "") {
		return "Name your table, e.g. Ford Road.";
	}

	return isTableName(tableSlug(name))
		? undefined
		: "A table's name needs a letter, e.g. Ford Road.";
};

export const wizardHandleProblem = (handle: string): string | undefined => {
	if (!isHandle(handle)) {
		return `Your handle is ${HANDLE_RULE}.`;
	}

	return isReservedHandle(handle)
		? `The handle ${handle} is reserved on a relay; pick another.`
		: undefined;
};

const RULES_BY: Readonly<Record<"left" | "right", 1 | -1>> = {
	left: -1,
	right: 1,
};

const typedName = (wizard: Wizard, key: WizardKey): WizardOutcome => {
	if (key.kind === "char" && wizard.name.length < NAME_LENGTH) {
		return editing({
			...wizard,
			name: `${wizard.name}${key.char}`,
			said: undefined,
		});
	}

	if (key.kind === "back") {
		return editing({
			...wizard,
			name: wizard.name.slice(0, -1),
			said: undefined,
		});
	}

	if (key.kind !== "enter") {
		return editing(wizard);
	}

	const problem = nameProblem(wizard.name);

	return problem === undefined
		? moveOn(wizard)
		: editing({ ...wizard, said: problem });
};

const typedHandle = (wizard: Wizard, key: WizardKey): WizardOutcome => {
	if (key.kind === "char") {
		const char = key.char.toLowerCase();

		return /^[a-z0-9-]$/u.test(char) && wizard.handle.length < HANDLE_LENGTH
			? editing({
					...wizard,
					handle: `${wizard.handle}${char}`,
					said: undefined,
				})
			: editing(wizard);
	}

	if (key.kind === "back") {
		return editing({
			...wizard,
			handle: wizard.handle.slice(0, -1),
			said: undefined,
		});
	}

	if (key.kind !== "enter") {
		return editing(wizard);
	}

	const problem = wizardHandleProblem(wizard.handle);

	return problem === undefined
		? moveOn(wizard)
		: editing({ ...wizard, said: problem });
};

const pickedRules = (wizard: Wizard, key: WizardKey): WizardOutcome => {
	if (key.kind === "left" || key.kind === "right") {
		const at = RULESET_NAMES.indexOf(wizard.rules);
		const by = RULES_BY[key.kind];

		const next =
			RULESET_NAMES[(at + by + RULESET_NAMES.length) % RULESET_NAMES.length];

		return editing({ ...wizard, rules: next ?? wizard.rules });
	}

	return key.kind === "enter" ? moveOn(wizard) : editing(wizard);
};

const pickedExample = (wizard: Wizard, key: WizardKey): WizardOutcome => {
	if (key.kind === "left" || key.kind === "right") {
		return editing({ ...wizard, example: !wizard.example });
	}

	if (key.kind === "char" && (key.char === "y" || key.char === "n")) {
		return editing({ ...wizard, example: key.char === "y" });
	}

	return key.kind === "enter" ? moveOn(wizard) : editing(wizard);
};

export const wizardKey = (wizard: Wizard, key: WizardKey): WizardOutcome => {
	if (key.kind === "escape") {
		return goBack(wizard);
	}

	if (wizard.step === "name") {
		return typedName(wizard, key);
	}

	if (wizard.step === "rules") {
		return pickedRules(wizard, key);
	}

	return wizard.step === "example"
		? pickedExample(wizard, key)
		: typedHandle(wizard, key);
};
