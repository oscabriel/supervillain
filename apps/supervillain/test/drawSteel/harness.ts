import type {
	Dice,
	Envelope,
	Command as TableCommand,
	HeroSheet,
	StatBlock,
	TableState,
} from "@supervillain/domain";
import {
	commands,
	feedLines,
	GM,
	plainText,
	rules,
	tableLabel,
} from "@supervillain/domain";

import { fold } from "../game/fold.ts";

export { GM };

export const ALICE = "key:SHA256:abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEFG";

export const BOB = "key:SHA256:Zyxwvuts+/0123456789abcdefghijklmnopqrstuvw";

export const table = { rules, commands };

export type State = TableState;

export type Command = TableCommand;

export const fixedDice = (...faces: Array<number>): Dice => {
	let i = 0;

	return () => {
		const face = faces[i];
		i += 1;

		if (face === undefined) {
			throw new Error("the fake dice ran out");
		}

		return face;
	};
};

export const noDice: Dice = () => {
	throw new Error("rolled when it should not have");
};

export class Table {
	readonly envelopes: Array<Envelope> = [];
	private clock = Date.parse("2026-10-21T19:00:00.000Z");

	get now(): string {
		return new Date(this.clock).toISOString();
	}

	get state(): State {
		const folded = fold(table.rules, this.envelopes, { strict: true });

		if (folded.error) {
			throw new Error(`replay halted: ${folded.error.message}`);
		}

		return folded.state;
	}

	get ds() {
		return this.state.ds;
	}

	submit(
		actor: string,
		command: Command,
		dice: Dice = noDice
	): string | undefined {
		const decision = table.rules.decide(
			this.state,
			actor,
			command,
			dice,
			this.clock
		);

		if ("refusal" in decision) {
			return decision.refusal;
		}

		const timestamp = this.now;

		for (const event of decision.events) {
			this.envelopes.push({
				actor,
				seq: this.envelopes.length + 1,
				timestamp,
				type: event.type,
				payload: event.payload,
			});
		}

		this.clock += 1000;

		return undefined;
	}

	run(actor: string, command: Command, dice: Dice = noDice): void {
		const refusal = this.submit(actor, command, dice);

		if (refusal !== undefined) {
			throw new Error(`refused: ${refusal}`);
		}
	}

	get feed(): ReadonlyArray<string> {
		const { state } = this;

		return feedLines(state, tableLabel(state, "draw-steel")).map(plainText);
	}

	lastFeed(n = 1): ReadonlyArray<string> {
		return this.feed.slice(-n);
	}

	hero(id: string) {
		const hero = this.ds.heroes.find((h) => h.id === id);

		if (!hero) {
			throw new Error(`no hero ${id}`);
		}

		return hero;
	}

	creature(id: string) {
		const creature = this.ds.creatures.find((c) => c.id === id);

		if (!creature) {
			throw new Error(`no creature ${id}`);
		}

		return creature;
	}
}

export const VEX: HeroSheet = {
	id: "vex",
	name: "Vex",
	class: "Censor",
	level: 1,
	characteristics: {
		might: 2,
		agility: 0,
		reason: -1,
		intuition: 1,
		presence: 2,
	},
	stamina: 21,
	recoveries: 8,
	speed: 5,
	stability: 1,
	resource: { name: "Wrath", perTurn: 2 },
	victories: 2,
	abilities: [
		{
			name: "Spinning Strike",
			kind: "Main action",
			characteristics: ["might", "agility"],
			keywords: ["Melee", "Strike", "Weapon"],
			distance: "Melee 1",
			target: "One creature",
			tier1: "3 damage",
			tier2: "5 damage; push 1",
			tier3: "7 damage; push 2",
		},
		{
			name: "Spirit Lash",
			kind: "Main action",
			characteristics: ["presence"],
			tier1: "2 holy damage",
			tier2: "4 holy damage",
			tier3: "6 holy damage; taunted (EoT)",
		},
	],
};

export const KOR: HeroSheet = {
	id: "kor",
	name: "Kor",
	class: "Fury",
	level: 1,
	characteristics: {
		might: 2,
		agility: 2,
		reason: -1,
		intuition: 0,
		presence: -1,
	},
	stamina: 24,
	recoveries: 10,
	recoveryValue: 9,
	speed: 6,
	stability: 0,
	resource: { name: "Ferocity", perTurn: "1d3" },
	victories: 2,
	weaknesses: [{ type: "holy", value: 3 }],
	abilities: [
		{
			name: "Brutal Slam",
			characteristics: ["might"],
			tier1: "3 damage",
			tier2: "6 damage",
			tier3: "9 damage",
		},
	],
};

export const GOBLIN: StatBlock = {
	id: "goblin-warrior",
	name: "Goblin Warrior",
	level: 1,
	organization: "horde",
	role: "Harrier",
	stamina: 15,
	speed: 6,
	stability: 0,
	freeStrike: 2,
	characteristics: {
		might: -2,
		agility: 2,
		reason: 0,
		intuition: 0,
		presence: -1,
	},
	abilities: [
		{
			name: "Spear Charge",
			kind: "Main action",
			bonus: 2,
			tier1: "3 damage",
			tier2: "4 damage",
			tier3: "5 damage",
		},
	],
};

export const RUNNER: StatBlock = {
	id: "goblin-runner",
	name: "Goblin Runner",
	level: 1,
	organization: "minion",
	role: "Harrier",
	ev: "3 for four minions",
	stamina: 5,
	speed: 7,
	stability: 0,
	freeStrike: 1,
	characteristics: {
		might: -2,
		agility: 2,
		reason: 0,
		intuition: 0,
		presence: -2,
	},
	abilities: [
		{
			name: "Dagger",
			bonus: 2,
			tier1: "1 damage",
			tier2: "2 damage",
			tier3: "3 damage",
		},
	],
	withCaptain: "Edge on strikes",
};

export const ARCHER: StatBlock = {
	...GOBLIN,
	id: "goblin-archer",
	name: "Goblin Archer",
	abilities: [
		{
			name: "Bow",
			bonus: 2,
			tier1: "2 damage",
			tier2: "3 damage",
			tier3: "4 damage",
		},
	],
};

export const IMP: StatBlock = {
	id: "ember-imp",
	name: "Ember Imp",
	level: 2,
	organization: "elite",
	stamina: 40,
	speed: 5,
	stability: 1,
	freeStrike: 4,
	characteristics: {
		might: 0,
		agility: 3,
		reason: 1,
		intuition: 1,
		presence: 0,
	},
	immunities: [
		{ type: "fire", value: 5 },
		{ type: "all", value: 2 },
	],
	weaknesses: [
		{ type: "holy", value: 4 },
		{ type: "all", value: 1 },
	],
	abilities: [],
};

export const type = (
	t: Table,
	actor: string,
	line: string,
	dice = fixedDice()
): string | undefined => {
	const groups = /^\/(?<name>\S+)\s*(?<args>.*)$/u.exec(line)?.groups;
	const name = groups?.name ?? "";
	const args = groups?.args ?? "";
	const spec = table.commands.find((c) => c.name === name);

	if (spec === undefined) {
		throw new Error(`no command /${name}`);
	}

	const command = spec.parse(args);

	if ("refusal" in command) {
		return command.refusal;
	}

	return t.submit(actor, command, dice);
};

export const ok = (
	t: Table,
	actor: string,
	line: string,
	dice = fixedDice()
): void => {
	const refusal = type(t, actor, line, dice);

	if (refusal !== undefined) {
		throw new Error(`refused: ${refusal}`);
	}
};

export const party = (): Table => {
	const t = new Table();
	t.run(GM, { type: "hero", hero: "vex", sheet: VEX });
	t.run(GM, { type: "hero", hero: "kor", sheet: KOR });
	t.run(ALICE, { type: "play", hero: "vex" });

	return t;
};
