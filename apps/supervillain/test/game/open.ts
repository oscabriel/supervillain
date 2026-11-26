import type { Command, Rules, TableState } from "@supervillain/domain";
import { rules } from "@supervillain/domain";

export const openInitial: TableState = {
	...rules.initial,
	core: { ...rules.initial.core, door: "open" },
};

export const openRules: Rules<TableState, Command> = {
	...rules,
	initial: openInitial,
};
