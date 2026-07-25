/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite. */
import { createActorLinks, readActorLinkedPayload } from "../src/index.js";
import { describe, expect, test } from "./harness.js";

const DESKTOP = "a".repeat(64);
const LAPTOP = "b".repeat(64);
const PHONE = "c".repeat(64);
const GUEST = "guest:abc123def456";

describe("actor links", () => {
	test("an unlinked actor is a class of one", () => {
		const links = createActorLinks();
		links.remember(DESKTOP);
		expect(links.same(DESKTOP, DESKTOP)).toBe(true);
		expect(links.same(DESKTOP, LAPTOP)).toBe(false);
		expect(links.members(DESKTOP)).toEqual([DESKTOP]);
	});

	test("unions two actors in both directions", () => {
		const links = createActorLinks();
		links.link(LAPTOP, DESKTOP);
		expect(links.same(DESKTOP, LAPTOP)).toBe(true);
		expect(links.same(LAPTOP, DESKTOP)).toBe(true);
	});

	test("is transitive across a chain of linkings", () => {
		const links = createActorLinks();
		links.link(LAPTOP, DESKTOP);
		links.link(PHONE, LAPTOP);
		expect(links.same(DESKTOP, PHONE)).toBe(true);
		expect(links.members(PHONE)).toHaveLength(3);
	});

	test("adopting a guest makes the historical actor reachable", () => {
		const links = createActorLinks();
		links.remember(GUEST);
		links.link(DESKTOP, GUEST);
		expect(links.same(GUEST, DESKTOP)).toBe(true);
		expect(links.members(GUEST)).toContain(DESKTOP);
	});

	test("linking twice changes nothing", () => {
		const links = createActorLinks();
		links.link(LAPTOP, DESKTOP);
		links.link(LAPTOP, DESKTOP);
		links.link(DESKTOP, LAPTOP);
		expect(links.members(DESKTOP)).toHaveLength(2);
	});

	test("reports every actor it has been told about, first seen first", () => {
		const links = createActorLinks();
		links.remember(DESKTOP);
		links.link(LAPTOP, GUEST);
		expect(links.actors()).toEqual([DESKTOP, LAPTOP, GUEST]);
	});
});

describe("actor linked payload", () => {
	test("reads the absorbed actor", () => {
		expect(readActorLinkedPayload({ linked: GUEST })).toBe(GUEST);
		expect(readActorLinkedPayload({ linked: `  ${DESKTOP} ` })).toBe(DESKTOP);
	});

	test("refuses payloads that name nobody", () => {
		expect(readActorLinkedPayload({ linked: "" })).toBeNull();
		expect(readActorLinkedPayload({ linked: 7 })).toBeNull();
		expect(readActorLinkedPayload({})).toBeNull();
		expect(readActorLinkedPayload(null)).toBeNull();
	});
});
