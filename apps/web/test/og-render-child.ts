import { readFile } from "node:fs/promises";

import type { SnapshotDocument } from "@supervillain/core";

import { renderArtifactCard } from "../src/server/og";

const inputPath = process.argv.at(2);
if (inputPath === undefined) {
	throw new Error("snapshot input path is required");
}
const document = JSON.parse(
	await readFile(inputPath, "utf-8")
) as SnapshotDocument;
process.stdout.write(await renderArtifactCard(document));
