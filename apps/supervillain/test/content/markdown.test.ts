import { describe, expect, test } from "bun:test";

import {
	gmOnly,
	isGmHeading,
	playerSafe,
	proseOf,
	readAloudOf,
	sectionsOf,
	splitFrontmatter,
} from "../../src/content/index.ts";

const body = (text: string) => {
	const split = splitFrontmatter(text);

	if ("problem" in split) {
		throw new Error(split.problem);
	}

	return split;
};

describe("splitFrontmatter", () => {
	test("takes the fields between --- lines and says where the body begins", () => {
		expect(splitFrontmatter("---\ntitle: The Market\n---\nStalls.\n")).toEqual({
			yaml: "title: The Market",
			body: "Stalls.\n",
			bodyLine: 4,
		});
	});

	test("a byte-order mark, CRLF line ends and a ... close all read", () => {
		expect(
			splitFrontmatter("﻿---\r\ntitle: A\r\nsummary: B\r\n...\r\nText\r\n")
		).toEqual({ yaml: "title: A\nsummary: B", body: "Text\n", bodyLine: 5 });
	});

	test("a file without fields, or with fields never closed, is a clean problem", () => {
		expect(splitFrontmatter("# Just a heading\n")).toEqual({
			problem: "must begin with a --- line, then its fields, then --- again",
			line: 1,
		});
		expect(splitFrontmatter("---\ntitle: A\n")).toEqual({
			problem: "opens its fields with --- but never closes them with ---",
			line: 1,
		});
	});
});

describe("sectionsOf", () => {
	test("ATX headings split the body; text before the first is the preamble", () => {
		const { preamble, sections } = sectionsOf(
			"Intro.\n\n# One #\nA\n## Two\nB\n###### Six\nC"
		);

		expect(preamble).toBe("Intro.\n");
		expect(sections.map((s) => [s.level, s.heading, s.text])).toEqual([
			[1, "One", "A"],
			[2, "Two", "B"],
			[6, "Six", "C"],
		]);
	});

	test("headings inside ``` and ~~~ fences are text, not sections", () => {
		const { sections } = sectionsOf(
			"## Scene\n```\n## GM Notes\n```\n~~~~\n# not a heading\n~~~~\n## After"
		);

		expect(sections.map((s) => s.heading)).toEqual(["Scene", "After"]);
		expect(sections[0]?.text).toContain("## GM Notes");
	});

	test("sections carry the line they start on in the file", () => {
		const split = body("---\ntitle: A\n---\nIntro\n## Two\n");
		const { sections } = sectionsOf(split.body, split.bodyLine);

		expect(sections[0]?.line).toBe(5);
	});
});

describe("player-safe and GM-only text", () => {
	const scene = sectionsOf(
		[
			"Stalls on stilts. <!-- the GM's aside -->",
			"",
			"## Read Aloud",
			"Water laps at the boards.",
			"## GM Notes",
			"GMSECRET the heir.",
			"### Secret door",
			"GMSECRET behind the stall.",
			"#### Deeper still",
			"GMSECRET a trapdoor.",
			"## Smells",
			"Brine and smoke.",
			"# Game Master's eyes only",
			"GMSECRET too.",
			"# Afterword",
			"<!--",
			"GMSECRET unclosed comment",
		].join("\n")
	);

	test("a GM heading hides its section and every deeper section under it", () => {
		const safe = playerSafe(scene);

		expect(safe).not.toContain("GMSECRET");
		expect(safe).toContain("## Smells\nBrine and smoke.");
		expect(safe).toContain("# Afterword");
	});

	test("HTML comments never reach the players, even one left open", () => {
		const safe = playerSafe(scene);

		expect(safe).not.toContain("aside");
		expect(safe).not.toContain("unclosed");
	});

	test("gmOnly gathers every GM block, subsections and all", () => {
		const notes = gmOnly(scene);

		expect(notes).toContain("GMSECRET the heir.");
		expect(notes).toContain("### Secret door");
		expect(notes).toContain("GMSECRET a trapdoor.");
		expect(notes).toContain("GMSECRET too.");
		expect(notes).not.toContain("Brine");
	});

	test("## Read Aloud is read out apart, and can be left out of the body", () => {
		expect(readAloudOf(scene)).toBe("Water laps at the boards.");
		expect(playerSafe(scene, (h) => h === "Read Aloud")).not.toContain("laps");
	});

	test("an underlined GM Notes heading hides its text, and only a # heading ends it", () => {
		const setext = sectionsOf(
			"Open.\n\nGM Notes\n--------\nGMSECRET\n\nStill notes\n==========\nGMSECRET too.\n# Open again\nYes."
		);

		expect(playerSafe(setext)).not.toContain("GMSECRET");
		expect(playerSafe(setext)).not.toContain("Still notes");
		expect(playerSafe(setext)).toContain("Yes.");
		expect(setext.problems.map((p) => p.line)).toEqual([8]);
	});

	test("a heading named gm without a word break isn't a GM heading", () => {
		expect(playerSafe(sectionsOf("## Gmork's lair\nHowls."))).toContain(
			"Howls."
		);
	});
});

describe("an underline inside GM notes never ends them", () => {
	for (const under of ["---", "==="]) {
		test(`${under} under a line of GM notes is text, never a heading`, () => {
			const parsed = sectionsOf(
				`## GM Notes\nThe duke is the murderer.\n${under}\nHis accomplice is the maid.`
			);

			expect(playerSafe(parsed)).toBe("");
			expect(readAloudOf(parsed)).toBeUndefined();
			expect(gmOnly(parsed)).toContain("His accomplice is the maid.");
			expect(parsed.problems).toEqual([
				{
					line: 3,
					message:
						"has a --- or === under a line of GM notes, which Markdown reads as a heading; leave a blank line above it, or use *** for a rule",
				},
			]);
		});
	}

	test("an underlined Read Aloud inside GM notes reads nothing aloud", () => {
		const parsed = sectionsOf(
			"## GM Notes\nRead Aloud\n==========\nThe duke did it."
		);

		expect(readAloudOf(parsed)).toBeUndefined();
		expect(playerSafe(parsed)).toBe("");
	});

	test("a list item, quote or rule above --- is never a heading", () => {
		const parsed = sectionsOf(
			"Intro.\n\n- GM Notes\n---\nShown.\n\n> GM\n---\nShown too.\n\n***\n---\nAnd this."
		);

		expect(parsed.sections).toEqual([]);
		expect(playerSafe(parsed)).toContain("Shown.");
		expect(playerSafe(parsed)).toContain("Shown too.");
		expect(playerSafe(parsed)).toContain("And this.");
	});

	test("an underlined paragraph of several lines is one heading", () => {
		const parsed = sectionsOf("Open.\n\nGM\nNotes\n---\nGMSECRET");

		expect(parsed.sections.map((s) => s.heading)).toEqual(["GM Notes"]);
		expect(playerSafe(parsed)).not.toContain("GMSECRET");
	});
});

describe("HTML comments are gone before headings are found", () => {
	test("a commented-out Read Aloud reads nothing aloud and shows nothing", () => {
		const parsed = sectionsOf("<!--\n## Read Aloud\nold draft\n-->");

		expect(readAloudOf(parsed)).toBeUndefined();
		expect(playerSafe(parsed)).toBe("");
	});

	test("a commented-out heading inside GM notes doesn't end them", () => {
		const parsed = sectionsOf(
			"## GM Notes\nGMSECRET one. <!--\n## Old public part\n-->\nGMSECRET two.\n## Public\nShown."
		);

		expect(playerSafe(parsed)).not.toContain("GMSECRET");
		expect(playerSafe(parsed)).not.toContain("Old public part");
		expect(playerSafe(parsed)).toContain("Shown.");
	});

	test("a commented-out GM heading hides nothing, and its comment shows nothing", () => {
		const parsed = sectionsOf("<!--\n## GM Notes\n-->\nPublic text.");

		expect(parsed.sections).toEqual([]);
		expect(playerSafe(parsed)).toBe("Public text.");
	});

	test("an unclosed comment hides everything after it, headings included", () => {
		const parsed = sectionsOf(
			"Shown.\n<!-- draft\n## Read Aloud\nGMSECRET\n## Public\nGMSECRET"
		);

		expect(parsed.sections).toEqual([]);
		expect(playerSafe(parsed)).toBe("Shown.");
		expect(readAloudOf(parsed)).toBeUndefined();
	});

	test("text after a closing --> is never a heading", () => {
		const parsed = sectionsOf(
			"## GM Notes\nGMSECRET <!--\nx\n--> ## Public\nGMSECRET still"
		);

		expect(parsed.sections.map((s) => s.heading)).toEqual(["GM Notes"]);
		expect(playerSafe(parsed)).toBe("");
	});

	test("<!-- inside a fence is code, not a comment", () => {
		const parsed = sectionsOf("```\n<!--\n```\n## GM Notes\nGMSECRET");

		expect(playerSafe(parsed)).toBe("```\n<!--\n```");
	});

	test("a blockquote or -> line inside a multiline comment never closes it early", () => {
		const parsed = sectionsOf(
			"Public\n<!--\n> SECRET old draft\n-> SECRET arrow\nSECRET2\n-->\nafter"
		);

		expect(playerSafe(parsed)).not.toContain("SECRET");
		expect(playerSafe(parsed)).toContain("Public");
		expect(playerSafe(parsed)).toContain("after");
		expect(parsed.problems).toEqual([]);
	});
});

describe("code fences follow CommonMark", () => {
	test("``` with a backtick in its info string isn't a fence", () => {
		for (const opener of ["```inline``` text", "``` js `x`"]) {
			const parsed = sectionsOf(`Shown.\n${opener}\n## GM Notes\nGMSECRET`);

			expect([opener, playerSafe(parsed)]).toEqual([
				opener,
				`Shown.\n${opener}`,
			]);
			expect(parsed.problems).toEqual([]);
		}
	});

	test("~~~ may carry backticks in its info string", () => {
		const parsed = sectionsOf("~~~ js `x`\n## GM Notes\n~~~\nShown.");

		expect(parsed.sections).toEqual([]);
	});

	test("an unclosed fence is a problem and can't swallow GM notes", () => {
		const parsed = sectionsOf("Shown.\n```\ncode\n## GM Notes\nGMSECRET", 4);

		expect(parsed.problems).toEqual([
			{
				line: 5,
				message:
					"opens a code fence that never closes; close it with the same ``` or ~~~",
			},
		]);
		expect(playerSafe(parsed)).toBe("Shown.");
		expect(gmOnly(parsed)).toContain("GMSECRET");
	});

	test("an unclosed fence inside GM notes shows players nothing after it", () => {
		const parsed = sectionsOf(
			"## Public\nShown.\n## GM Notes\n```\n## Not public\nGMSECRET"
		);

		expect(playerSafe(parsed)).toBe("## Public\nShown.");
	});

	test("prose and sections read the same fences", () => {
		expect(proseOf("```inline``` text\nmore").map((b) => b.kind)).toEqual([
			"para",
		]);
		expect(proseOf("~~~ js `x`\ncode\n~~~").map((b) => b.kind)).toEqual([
			"pre",
		]);
	});
});

describe("GM headings", () => {
	test("every way of writing a GM heading hides its section", () => {
		for (const heading of [
			"## GM Notes",
			"## **GM Notes**",
			"## _GM Notes_",
			"## `GM` notes",
			"## ~~GM~~ Notes:",
			"## GMs only",
			"## GM's eyes only",
			"## Gamemaster Notes",
			"## Game Master",
			"## DM Notes",
			"## DMs only",
			"## Dungeon Master notes",
			"## Director notes",
			"## Director's Notes",
			"## Director’s Notes",
			"## Directors' Notes",
			"## Director Only",
			"## Director's Eyes Only",
			"## Game-Master Notes",
			"## GM_Notes",
			"## GMNotes",
			"## Secret",
			"## Secrets",
			"## [GM] notes",
			"## 🔒 GM Notes",
			"##GM Notes",
		]) {
			const parsed = sectionsOf(`Shown.\n${heading}\nGMSECRET`);

			expect([heading, playerSafe(parsed)]).toEqual([heading, "Shown."]);
		}
	});

	test("isGmHeading matches only at the start, on a word", () => {
		expect(isGmHeading("Gmork's lair")).toBe(false);
		expect(isGmHeading("DMV office")).toBe(false);
		expect(isGmHeading("The Secret Garden")).toBe(false);
		expect(isGmHeading("**gm**")).toBe(true);
	});

	test("near misses are problems: a GM heading with no space, one that mentions the GM, a bold label", () => {
		const parsed = sectionsOf(
			"##GM Notes\nGMSECRET\n## Notes for the GM\nOops.\n## Spoilers\nOops.\n\n**GM Notes:**\nOops."
		);

		expect(
			parsed.problems.map((p) => [p.line, p.message.slice(0, 24)])
		).toEqual([
			[1, "has a GM heading with no"],
			[3, 'has the heading "Notes f'],
			[5, 'has the heading "Spoiler'],
			[8, 'has "**GM Notes:**" on a'],
		]);
	});
});

describe("proseOf", () => {
	test("paragraphs, lists, quotes, headings and fenced lines become blocks", () => {
		expect(
			proseOf(
				[
					"# The **Drowned** Market",
					"Stalls on",
					"stilts.",
					"",
					"- one",
					"- two",
					"  continued",
					"1. first",
					"2) second",
					"> said",
					"> softly",
					"",
					"---",
					"```",
					"  a\tb",
					"```",
					"A [link](https://example.com) and `code`.",
				].join("\n")
			)
		).toEqual([
			{ kind: "heading", level: 1, text: "The Drowned Market" },
			{ kind: "para", text: "Stalls on stilts." },
			{ kind: "list", ordered: false, items: ["one", "two continued"] },
			{ kind: "list", ordered: true, items: ["first", "second"] },
			{ kind: "quote", text: "said softly" },
			{ kind: "pre", lines: ["  a    b"] },
			{ kind: "para", text: "A link and code." },
		]);
	});

	test("terminal escapes are cleaned from text and pre lines alike", () => {
		const prose = proseOf(
			"Bad \u001B[31mred\n```\nx\u001B]0;title\u0007y\n```"
		);

		expect(JSON.stringify(prose)).not.toContain("\u001B");
		expect(JSON.stringify(prose)).not.toContain("\u0007");
	});

	test("an underlined heading and an unclosed fence still parse", () => {
		expect(proseOf("Title\n=====\n```\nkept")).toEqual([
			{ kind: "heading", level: 1, text: "Title" },
			{ kind: "pre", lines: ["kept"] },
		]);
	});

	test("the same Markdown always parses the same way", () => {
		const text = "# A\n\nB\n\n- c\n";

		expect(proseOf(text)).toEqual(proseOf(text));
	});
});
