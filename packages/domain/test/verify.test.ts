import { describe, expect, test } from "bun:test";

import * as Domain from "@alchemy.run/domain";

import { CORE_COMMANDS } from "../src/commands/core.ts";
import { DS_COMMANDS } from "../src/commands/drawSteel.ts";
import { PF_COMMANDS } from "../src/commands/pf2e.ts";
import { SW_COMMANDS } from "../src/commands/setWorld.ts";
import { CORE_EVENTS } from "../src/events/core.ts";
import { DS_EVENTS } from "../src/events/drawSteel.ts";
import { PF_EVENTS } from "../src/events/pf2e.ts";
import { SW_EVENTS } from "../src/events/setWorld.ts";
import { Refused } from "../src/Refused.rejection.ts";
import { rules } from "../src/rules/compose.ts";
import { CorePayloads } from "../src/rules/core/core.ts";
import { Payloads as DsPayloads } from "../src/rules/drawSteel/events.ts";
import { Payloads as PfPayloads } from "../src/rules/pf2e/events.ts";
import { Payloads as SwPayloads } from "../src/rules/setWorld/events.ts";
import { Supervillain } from "../src/Supervillain.model.ts";
import { Table } from "../src/Table.aggregate.ts";

const PAYLOADS = [
	...Object.entries(CorePayloads),
	...Object.entries(DsPayloads),
	...Object.entries(SwPayloads),
	...Object.entries(PfPayloads),
];

const EVENTS = [...CORE_EVENTS, ...DS_EVENTS, ...SW_EVENTS, ...PF_EVENTS];

const COMMANDS = [
	...CORE_COMMANDS,
	...DS_COMMANDS,
	...SW_COMMANDS,
	...PF_COMMANDS,
];

describe("the model", () => {
	test("is well defined", () => {
		expect(Domain.verify(Supervillain)).toEqual([]);
	});

	test("no payload carries the envelope's own keys", () => {
		const clashes = PAYLOADS.flatMap(([type, schema]) =>
			Object.keys(schema.fields)
				.filter((key) => key === "_tag" || key === "actor")
				.map((key) => `${type}.${key}`)
		);

		expect(clashes).toEqual([]);
	});

	test("every event is tagged with its log type, and the rules fold each one", () => {
		const tags: ReadonlyArray<string> = EVENTS.map((event) => event.tag);

		expect(tags.toSorted()).toEqual(PAYLOADS.map(([type]) => type).toSorted());
		expect(tags.filter((tag) => !rules.knows(tag))).toEqual([]);
	});

	test("every event carries its actor beside its payload, and nothing else", () => {
		const extra = EVENTS.flatMap((event) => {
			const payload = PAYLOADS.find(([type]) => type === event.tag)?.[1];
			const expected = ["_tag", "actor", ...Object.keys(payload?.fields ?? {})];

			return Object.keys(event.fields).toSorted().join(",") ===
				expected.toSorted().join(",")
				? []
				: [event.tag];
		});

		expect(extra).toEqual([]);
	});

	test("every command is decided by the table, and refuses with Refused", () => {
		expect(Table.definition.commands.map((c) => c.tag).toSorted()).toEqual(
			COMMANDS.map((c) => c.tag).toSorted()
		);
		expect(
			COMMANDS.flatMap((command) =>
				command.rejects.length === 1 && command.rejects[0] === Refused
					? []
					: [command.tag]
			)
		).toEqual([]);
	});

	test("the table's events are its commands' events, each one declared once", () => {
		const declared = new Set(
			COMMANDS.flatMap((command) => command.events.map((event) => event.tag))
		);

		expect([...declared].toSorted()).toEqual(
			EVENTS.map((event) => event.tag).toSorted()
		);
	});
});
