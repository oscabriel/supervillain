import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

export class Refused extends Domain.Rejection("Refused", {
	message: Schema.String,
}) {}

export class Added extends Domain.Event("Added", {
	actor: Schema.String,
	n: Schema.Int,
}) {}

export class Poisoned extends Domain.Event("Poisoned", {
	actor: Schema.String,
}) {}

export class Add extends Domain.Command("Add", {
	target: Schema.String,
	input: { actor: Schema.String, n: Schema.Int },
	events: [Added],
	rejects: [Refused],
	reply: { total: Schema.Int },
}) {}

export class Double extends Domain.Command("Double", {
	target: Schema.String,
	input: { actor: Schema.String, n: Schema.Int },
	events: [Added],
	rejects: [Refused],
}) {}

export class Poison extends Domain.Command("Poison", {
	target: Schema.String,
	input: { actor: Schema.String },
	events: [Added, Poisoned],
	rejects: [Refused],
}) {}

export class Tally extends Domain.Aggregate("Tally", {
	id: Schema.String,
	state: Schema.Struct({ total: Schema.Int }),
	initial: { total: 0 },
	commands: [Add, Double, Poison],
	decide: {
		Add: (_state, command) =>
			command.n < 0
				? new Refused({ message: "not today" })
				: [new Added({ actor: command.actor, n: command.n })],
		Double: (_state, command) => [
			new Added({ actor: command.actor, n: command.n }),
			new Added({ actor: command.actor, n: command.n }),
		],
		Poison: (_state, command) => [
			new Added({ actor: command.actor, n: 1 }),
			new Poisoned({ actor: command.actor }),
		],
	},
	evolve: {
		Added: (state, event) => ({ total: state.total + event.n }),
		Poisoned: () => {
			throw new Error("evolve blew up");
		},
	},
	reply: {
		Add: (state) => ({ total: state.total }),
	},
}) {}

export class Table extends Domain.Model("Table", { aggregates: [Tally] }) {}
