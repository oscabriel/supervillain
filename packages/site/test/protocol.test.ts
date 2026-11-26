import { describe, expect, test } from "bun:test";

import { homeView, whatIsDialogView } from "../src/Home.ts";
import { protocolContentView } from "../src/Protocol.ts";
import {
	ALL_RULESETS,
	commandCatalog,
	ENVELOPE_SCHEMA_JSON,
	MCP_RESOURCES,
	mcpCatalogDocument,
	META_TOOLS,
} from "../src/ProtocolData.ts";
import { parsePublicKey, relayInfoFrom } from "../src/RelayInfo.ts";
import { htmlOf } from "./render.ts";

describe("the protocol and MCP catalog", () => {
	test("generates typed command tools for all four rulesets with host facts stripped and no trademark drift", () => {
		for (const ruleset of ALL_RULESETS) {
			const cmds = commandCatalog(ruleset);
			expect(cmds.length).toBeGreaterThan(10);

			const doc = mcpCatalogDocument(ruleset);
			expect(doc.subsystem).toBe("mcp-1@supervillain.sh");
			expect(doc.tools.length).toBeGreaterThan(cmds.length);
			expect(doc.resources).toStrictEqual(MCP_RESOURCES);

			const text = JSON.stringify(doc);
			expect(text).not.toContain("Pathfinder");
			expect(text).not.toContain("—");

			for (const cmd of cmds) {
				for (const fact of cmd.hostFacts) {
					expect(cmd.params.some((param) => param.name === fact)).toBe(false);
				}
			}
		}

		expect(
			META_TOOLS.some(
				(tool) =>
					tool.name === "set_auto_foes" &&
					tool.rulesets.includes("set-world") &&
					!tool.rulesets.includes("draw-steel")
			)
		).toBe(true);
		expect(ENVELOPE_SCHEMA_JSON).toContain('"actor"');
		expect(ENVELOPE_SCHEMA_JSON).toContain('"seq"');
	});

	test("renders the interactive protocol view and filters by role and query", async () => {
		const gmHtml = await htmlOf((model, h) =>
			h.div([], protocolContentView(model, h))
		);

		expect(gmHtml).toContain("get_table_state");
		expect(gmHtml).toContain("batch_commands");
		expect(gmHtml).toContain("cmd_show");
		expect(gmHtml).toContain("supervillain://campaign/files");
		expect(gmHtml).toContain("/schemas/mcp/draw-steel.json");
		expect(gmHtml).toContain("/schemas/envelope.schema.json");
		expect(gmHtml).not.toContain("Pathfinder");
		expect(gmHtml).not.toContain("—");

		const playerHtml = await htmlOf((model, h) =>
			h.div(
				[],
				protocolContentView(
					{ ...model, protocolRole: "player", protocolQuery: "roll" },
					h
				)
			)
		);

		expect(playerHtml).not.toContain("batch_commands");
		expect(playerHtml).not.toContain("supervillain://campaign/files");
		expect(playerHtml).toContain("cmd_roll");
	});
});

describe("the hero What is this? dialog and host key verification", () => {
	test("places What is this? next to Click to copy in the hero", async () => {
		const html = await htmlOf((model, h) => h.div([], homeView(model, h)));

		expect(html).toContain("Click to copy");
		expect(html).toContain("What is this?");
		expect(html).not.toContain('role="dialog"');
	});

	test("parses SSH public key formats and renders fingerprint and known_hosts in the dialog", async () => {
		const sampleKey =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGSamplePublicKeyDataForTesting12345678";

		expect(parsePublicKey(sampleKey)).toStrictEqual({
			algorithm: "ssh-ed25519",
			keyData:
				"AAAAC3NzaC1lZDI1NTE5AAAAIGSamplePublicKeyDataForTesting12345678",
		});

		expect(parsePublicKey(`supervillain.sh ${sampleKey} relay`)).toStrictEqual({
			algorithm: "ssh-ed25519",
			keyData:
				"AAAAC3NzaC1lZDI1NTE5AAAAIGSamplePublicKeyDataForTesting12345678",
		});

		const configured = relayInfoFrom(
			"supervillain.sh",
			sampleKey,
			"SHA256:TestFingerprintValue"
		);

		const withKey = await htmlOf((_model, h) =>
			whatIsDialogView("", h, configured)
		);

		expect(withKey).toContain('role="dialog"');
		expect(withKey).toContain('aria-modal="true"');
		expect(withKey).toContain("ssh supervillain.sh");
		expect(withKey).not.toContain("Inside the lobby");
		expect(withKey).toContain('href="/guide/playing"');
		expect(withKey).toContain("SHA256:TestFingerprintValue");
		expect(withKey).toContain("Add this to ~/.ssh/known_hosts");
		expect(withKey).toContain(`<code>supervillain.sh ${sampleKey}</code>`);
		expect(withKey).not.toContain("mkdir -p");
		expect(withKey).not.toContain("—");

		const fallback = await htmlOf((_model, h) =>
			whatIsDialogView("", h, relayInfoFrom("supervillain.sh", "", ""))
		);

		expect(fallback).toContain(
			"ssh-keyscan -t ed25519 supervillain.sh | ssh-keygen -lf -"
		);
	});
});
