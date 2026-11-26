import { RULESET_NAMES } from "@supervillain/domain";
import type { RulesetName } from "@supervillain/domain";

import {
	DEFAULT_RELAY,
	HANDLE_RULE,
	isHandle,
	isReservedHandle,
	isTableName,
	TABLE_RULE,
} from "../protocol.ts";

export const INSTALL_URL = "https://supervillain.sh/install";

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | sh`;

export const KEYLESS_CREATE =
	"Creating a table needs an SSH key so your handle belongs to you: run ssh-keygen -t ed25519 and reconnect.";

const NAME_LENGTH = 32;

export type CreateStep = "handle" | "table" | "ready";

export interface Ready {
	readonly code: string;
	readonly until: number;
}

export interface CreateForm {
	readonly guest: boolean;
	readonly held: string | undefined;
	readonly step: CreateStep;
	readonly handle: string;
	readonly table: string;
	readonly rules: RulesetName;
	readonly said: string | undefined;
	readonly ready: Ready | undefined;
	readonly relay: string | undefined;
}

export type CreateKey =
	| { readonly kind: "char"; readonly char: string }
	| { readonly kind: "back" }
	| { readonly kind: "enter" }
	| { readonly kind: "left" }
	| { readonly kind: "right" };

export type CreateAsk =
	| { readonly kind: "claim"; readonly handle: string }
	| {
			readonly kind: "mint";
			readonly handle: string;
			readonly table: string;
			readonly rules: RulesetName;
	  };

export interface Stepped {
	readonly form: CreateForm;
	readonly ask?: CreateAsk;
}

export type Claimed =
	| { readonly kind: "held"; readonly handle: string }
	| { readonly kind: "refused"; readonly reason: string };

export type Paired =
	| { readonly kind: "minted"; readonly code: string; readonly until: number }
	| { readonly kind: "refused"; readonly reason: string };

export const createForm = (
	guest: boolean,
	held: string | undefined,
	relay?: string
): CreateForm => ({
	guest,
	held,
	step: "handle",
	handle: held ?? "",
	table: "",
	rules: "draw-steel",
	said: undefined,
	ready: undefined,
	relay: relay === undefined || relay === DEFAULT_RELAY ? undefined : relay,
});

const isNameChar = (char: string) => /^[a-z0-9-]$/u.test(char);

const typedInto = (text: string, char: string) => {
	const lower = char.toLowerCase();

	return isNameChar(lower) && text.length < NAME_LENGTH
		? `${text}${lower}`
		: text;
};

const rulesBy = (rules: RulesetName, by: 1 | -1): RulesetName => {
	const at = RULESET_NAMES.indexOf(rules);
	const next = (at + by + RULESET_NAMES.length) % RULESET_NAMES.length;

	return RULESET_NAMES[next] ?? rules;
};

export const handleProblem = (handle: string): string | undefined => {
	if (handle === "") {
		return "Type the handle you want, then Enter.";
	}

	if (!isHandle(handle)) {
		return `A handle is ${HANDLE_RULE}.`;
	}

	return isReservedHandle(handle)
		? `The handle ${handle} is reserved; pick another.`
		: undefined;
};

export const tableProblem = (table: string): string | undefined => {
	if (table === "") {
		return "Type your table's name, then Enter.";
	}

	return isTableName(table) ? undefined : `A table's name is ${TABLE_RULE}.`;
};

const handleStep = (form: CreateForm, key: CreateKey): Stepped => {
	if (form.held !== undefined) {
		return key.kind === "enter"
			? { form: { ...form, step: "table", said: undefined } }
			: { form };
	}

	if (key.kind === "char") {
		return {
			form: {
				...form,
				handle: typedInto(form.handle, key.char),
				said: undefined,
			},
		};
	}

	if (key.kind === "back") {
		return {
			form: { ...form, handle: form.handle.slice(0, -1), said: undefined },
		};
	}

	if (key.kind !== "enter") {
		return { form };
	}

	const problem = handleProblem(form.handle);

	return problem === undefined
		? {
				form: { ...form, said: undefined },
				ask: { kind: "claim", handle: form.handle },
			}
		: { form: { ...form, said: problem } };
};

const tableStep = (form: CreateForm, key: CreateKey): Stepped => {
	if (key.kind === "char") {
		return {
			form: {
				...form,
				table: typedInto(form.table, key.char),
				said: undefined,
			},
		};
	}

	if (key.kind === "back") {
		return form.table === "" && form.held === undefined
			? { form: { ...form, step: "handle", said: undefined } }
			: { form: { ...form, table: form.table.slice(0, -1), said: undefined } };
	}

	if (key.kind === "left" || key.kind === "right") {
		return {
			form: {
				...form,
				rules: rulesBy(form.rules, key.kind === "left" ? -1 : 1),
				said: undefined,
			},
		};
	}

	const problem = tableProblem(form.table);

	return problem === undefined
		? {
				form: { ...form, said: undefined },
				ask: {
					kind: "mint",
					handle: form.handle,
					table: form.table,
					rules: form.rules,
				},
			}
		: { form: { ...form, said: problem } };
};

export const createKey = (form: CreateForm, key: CreateKey): Stepped => {
	if (form.guest || form.step === "ready") {
		return { form };
	}

	return form.step === "handle" ? handleStep(form, key) : tableStep(form, key);
};

export const afterClaim = (form: CreateForm, outcome: Claimed): CreateForm =>
	outcome.kind === "held"
		? {
				...form,
				held: outcome.handle,
				handle: outcome.handle,
				step: "table",
				said: `You hold ${outcome.handle} now.`,
			}
		: { ...form, said: outcome.reason };

export const afterPairing = (form: CreateForm, outcome: Paired): CreateForm =>
	outcome.kind === "minted"
		? {
				...form,
				step: "ready",
				said: undefined,
				ready: { code: outcome.code, until: outcome.until },
			}
		: { ...form, said: outcome.reason };

export interface Commands {
	readonly install: string;
	readonly create: string;
}

export const commandsOf = (form: CreateForm, ready: Ready): Commands => ({
	install: INSTALL_COMMAND,
	create: `supervillain new ${form.table} --rules ${form.rules} --handle ${form.handle} --claim ${ready.code}${form.relay === undefined ? "" : ` --relay ${form.relay}`}`,
});

export const commandsText = (commands: Commands): string =>
	`${commands.install}\n${commands.create}`;
