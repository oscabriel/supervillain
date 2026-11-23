export type ActionPick = "none" | "square" | "target" | "targets";

export interface TokenAction {
	readonly label: string;
	readonly pick: ActionPick;
	readonly line: string;
}

export const actionLine = (
	action: TokenAction,
	picked: ReadonlyArray<string>
): string => {
	if (picked.length === 0) {
		return action.line;
	}

	return action.pick === "targets"
		? `${action.line} on ${picked.join(" ")}`
		: `${action.line} ${picked[0]}`;
};
