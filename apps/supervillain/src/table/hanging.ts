const HANGING = /^(?<lead> *(?:\S(?:.*?\S)? {2,})?)(?<rest>.*)$/u;

export interface Hanging {
	readonly lead: string;
	readonly rest: string;
}

export const hanging = (text: string): ReadonlyArray<Hanging> =>
	text.split("\n").map((line) => {
		const groups = HANGING.exec(line)?.groups;
		const lead = groups?.lead ?? "";
		const rest = groups?.rest;

		if (rest === "") {
			return { lead: "", rest: line === "" ? " " : line };
		}

		return { lead, rest: rest ?? line };
	});
