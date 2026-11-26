import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../../..");

const PRINTED = [
	"apps/supervillain/src",
	"packages/domain/src",
	"packages/platform-jsonl/src",
	"packages/ssh/src",
	"scripts",
];

const EM_DASH = "\u2014";

const filesIn = (folder: string): Array<string> =>
	readdirSync(path.join(ROOT, folder), {
		recursive: true,
		withFileTypes: true,
	}).flatMap((entry) =>
		entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []
	);

describe("what the terminal prints", () => {
	test("never joins clauses with an em-dash", () => {
		const files = PRINTED.flatMap(filesIn);

		const offenders = files.flatMap((file) =>
			readFileSync(file, "utf-8").includes(EM_DASH)
				? [path.relative(ROOT, file)]
				: []
		);

		expect(files.length).toBeGreaterThan(100);
		expect(offenders).toStrictEqual([]);
	});
});
