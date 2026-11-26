import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { buildProtocolSnapshot } from "../src/ProtocolData.ts";
import { ALL_RULESETS } from "../src/ProtocolTypes.ts";

const SOURCES = `${import.meta.dirname}/../src`;

const DOMAIN = "@supervillain/domain";

const BUILD_ONLY = "./ProtocolData.ts";

const STATEMENT =
	/(?:^|\n)(?:import|export)\s+(?!type\b)(?:[^;"]*?\sfrom\s+)?"(?<source>[^"]+)"/gu;

const DYNAMIC = /\bimport\(\s*"(?<source>[^"]+)"/gu;

interface Loaded {
	readonly file: string;
	readonly sources: ReadonlyArray<string>;
}

const sourcesOf = (text: string): Array<string> =>
	[...text.matchAll(STATEMENT), ...text.matchAll(DYNAMIC)].map(
		(found) => found.groups?.source ?? ""
	);

const loaded = (): Array<Loaded> =>
	readdirSync(SOURCES, { recursive: true, encoding: "utf-8" }).flatMap((file) =>
		file.endsWith(".ts")
			? [
					{
						file,
						sources: sourcesOf(readFileSync(`${SOURCES}/${file}`, "utf-8")),
					},
				]
			: []
	);

const loading = (
	modules: ReadonlyArray<Loaded>,
	wanted: (source: string) => boolean
): Array<string> =>
	modules.flatMap(({ file, sources }) => (sources.some(wanted) ? [file] : []));

describe("the line between the build and the browser", () => {
	test("reads its own import statements, typed ones apart", () => {
		expect(
			sourcesOf(
				[
					'import { a } from "./a.ts";',
					'import type { B } from "./b.ts";',
					"import {",
					"\tc,",
					"\ttype D,",
					'} from "./c.ts";',
					'export { e } from "./e.ts";',
					'export type { F } from "./f.ts";',
					'import "./g.css";',
					'const h = await import("./h.ts");',
				].join("\n")
			)
		).toStrictEqual(["./a.ts", "./c.ts", "./e.ts", "./g.css", "./h.ts"]);
	});

	test("lets only the build-time catalog load the domain", () => {
		const modules = loaded();

		expect(modules.length).toBeGreaterThan(20);
		expect(
			loading(
				modules,
				(source) => source === DOMAIN || source.startsWith(`${DOMAIN}/`)
			)
		).toStrictEqual(["ProtocolData.ts"]);
		expect(loading(modules, (source) => source === BUILD_ONLY)).toStrictEqual([
			"ProtocolSnapshot.ts",
		]);
	});

	test("has a full snapshot for the build to inline in the catalog's place", () => {
		const snapshot = buildProtocolSnapshot();

		expect(
			ALL_RULESETS.filter((ruleset) => snapshot.commands[ruleset].length === 0)
		).toStrictEqual([]);
		expect(snapshot.metaTools.length).toBeGreaterThan(0);
		expect(snapshot.resources.length).toBeGreaterThan(0);
		expect(snapshot.campaignSchemas.length).toBeGreaterThan(0);
		expect(snapshot.envelopeSchemaJson).not.toBe("");
	});
});
