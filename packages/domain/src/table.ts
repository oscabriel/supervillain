import type { TokenAction } from "./actions.ts";
import type { EncounterSpec, PartyMember } from "./party.ts";
import type { PrepCatalog, PrepView } from "./prep.ts";
import { commands, feedFormat } from "./rules/compose.ts";
import type { TableSpec, TableState } from "./rules/compose.ts";
import { labelOf } from "./rules/core/core.ts";
import { GM } from "./rules/core/module.ts";
import type { CombatView, MapView } from "./rules/drawSteel/index.ts";
import type { Refused } from "./rules/engine.ts";
import { RULESETS } from "./Ruleset.ts";
import type { RulesetName, TableView } from "./Ruleset.ts";
import { nameKey } from "./text.ts";

export {
	commands,
	feedFormat,
	initial,
	KNOCK_FIRST,
	rules,
	type Command,
	type RedoEntry,
	type Slices,
	type TableSpec,
	type TableState,
	type UndoBatch,
} from "./rules/compose.ts";

export const commandsFor = (ruleset: RulesetName): ReadonlyArray<TableSpec> =>
	commands.filter((c) => c.ruleset === undefined || c.ruleset === ruleset);

export const tableLabel = (
	state: TableView,
	ruleset: RulesetName
): ((actor: string) => string) => RULESETS[ruleset].label(state);

export const bandOf = (
	state: TableView,
	actor: string,
	ruleset: RulesetName
): CombatView | undefined => RULESETS[ruleset].band(state, actor);

export const mapOf = (
	state: TableView,
	actor: string,
	ruleset: RulesetName
): MapView | undefined => RULESETS[ruleset].map(state, actor);

export const actionsOf = (
	state: TableView,
	actor: string,
	ruleset: RulesetName,
	id: string
): ReadonlyArray<TokenAction> | undefined =>
	RULESETS[ruleset].actions(state, actor, id);

export const prepOf = (
	state: TableView,
	catalog: PrepCatalog,
	ruleset: RulesetName
): PrepView => RULESETS[ruleset].prep(state, catalog);

export const sheetOf = (
	state: TableView,
	who: string,
	ruleset: RulesetName
): string | Refused => RULESETS[ruleset].sheet(state, who);

export const partyOf = (
	state: TableView,
	actor: string,
	ruleset: RulesetName
): ReadonlyArray<PartyMember> => RULESETS[ruleset].party(state, actor);

export const sheetTargetFor = (
	state: TableView,
	actor: string,
	who: string,
	ruleset: RulesetName
): string | undefined => {
	if (actor === GM) {
		return who;
	}

	const wanted = nameKey(who);

	return partyOf(state, actor, ruleset).find(
		(member) => member.id === who || nameKey(member.name) === wanted
	)?.id;
};

export const notInParty = (who: string): string =>
	`No one in the party is called "${who}".`;

export const inCombatOf = (state: TableView, ruleset: RulesetName): boolean =>
	RULESETS[ruleset].inCombat(state);

export const fightLinesOf = (
	encounter: EncounterSpec,
	ruleset: RulesetName
): ReadonlyArray<string> => RULESETS[ruleset].fightLines(encounter);

export const resyncLinesOf = (
	state: TableView,
	changed: ReadonlyArray<string>,
	ruleset: RulesetName
): ReadonlyArray<string> => RULESETS[ruleset].resyncLines(state, changed);

export const completeSheet = (
	state: TableView,
	partial: string,
	actor: string,
	ruleset: RulesetName
): ReadonlyArray<string> =>
	RULESETS[ruleset].completeSheet(state, partial, actor);

export interface FeedLine {
	readonly seq: number;
	readonly who: string;
	readonly kind: string;
	readonly text: string;
	readonly gm: boolean;
}

export const feedLines = (
	state: Pick<TableState, "feed" | "core">,
	label: (actor: string) => string
): ReadonlyArray<FeedLine> => {
	const plain = labelOf(state);

	return state.feed.map((e) => {
		const speaker = e.speaker ?? e.actor;
		const format = feedFormat(e.kind);
		const who = format.plainLabel === true ? plain(speaker) : label(speaker);

		return {
			seq: e.seq,
			who: format.mark === undefined ? who : `${format.mark} ${who}`,
			kind: e.kind,
			text: e.text,
			gm: speaker === GM,
		};
	});
};

export const plainText = (
	line: Pick<FeedLine, "who" | "kind" | "text">
): string => {
	const format = feedFormat(line.kind);

	return format.speaker
		? `${line.who}${format.separator}${line.text}`
		: line.text;
};
