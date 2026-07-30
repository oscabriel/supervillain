/* oxlint-disable eslint/no-await-in-loop, vitest/prefer-importing-vitest-globals -- sequential CLI calls exercise one artifact lifecycle. */
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateSnapshotDocument } from "@supervillain/core";
import type { SnapshotDocumentV1 } from "@supervillain/core";

const AUTH_DOMAIN = "supervillain/publish-http/1\n";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];

interface PublishedArtifact {
	readonly document: SnapshotDocumentV1;
	readonly name: string;
	readonly publishedAt: string;
	readonly type: "character" | "log" | "map";
	readonly url: string;
}

const authenticated = (
	request: Request,
	challenges: Map<string, string>
): boolean => {
	const key = request.headers.get("supervillain-key") ?? "";
	const challenge = request.headers.get("supervillain-challenge") ?? "";
	const signature = request.headers.get("supervillain-signature") ?? "";
	const expectedKey = challenges.get(challenge);
	challenges.delete(challenge);
	if (expectedKey !== key) {
		return false;
	}
	const publicKey = createPublicKey({
		format: "der",
		key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key, "hex")]),
		type: "spki",
	});
	return verify(
		null,
		Buffer.from(`${AUTH_DOMAIN}${challenge}\n${key}`),
		publicKey,
		Buffer.from(signature, "hex")
	);
};

const startPublishServer = () => {
	const artifacts = new Map<string, PublishedArtifact>();
	const challenges = new Map<string, string>();
	let nextFailure:
		| { readonly body: unknown; readonly status: number }
		| undefined;
	const server = Bun.serve({
		fetch: async (request) => {
			const url = new URL(request.url);
			if (
				url.pathname === "/api/publish/challenge" &&
				request.method === "POST"
			) {
				const { key } = (await request.json()) as { readonly key: string };
				const challenge = "ab".repeat(32);
				challenges.set(challenge, key);
				return Response.json({ challenge }, { status: 201 });
			}
			if (
				url.pathname !== "/api/publish" ||
				!authenticated(request, challenges)
			) {
				return Response.json(
					{ error: "authentication failed" },
					{ status: 401 }
				);
			}
			if (nextFailure !== undefined) {
				const failure = nextFailure;
				nextFailure = undefined;
				return Response.json(failure.body, { status: failure.status });
			}
			if (request.method === "GET") {
				return Response.json({
					artifacts: [...artifacts.values()].map(
						({ document: _document, ...artifact }) => artifact
					),
				});
			}
			const body = (await request.json()) as {
				readonly document?: SnapshotDocumentV1;
				readonly name: string;
				readonly type: "character" | "log" | "map";
			};
			const key = `${body.type}:${body.name}`;
			if (request.method === "DELETE") {
				if (!artifacts.delete(key)) {
					return Response.json(
						{ error: "artifact not found" },
						{ status: 404 }
					);
				}
				return Response.json({
					message:
						"Revoked. Chat apps may retain unfurl previews already rendered in chat history.",
				});
			}
			if (
				body.document === undefined ||
				!validateSnapshotDocument(body.document).ok
			) {
				return Response.json(
					{ error: { code: "invalid-snapshot" } },
					{ status: 400 }
				);
			}
			const created = !artifacts.has(key);
			const artifact = {
				document: body.document,
				name: body.name,
				publishedAt: "2026-07-30T12:00:00.000Z",
				type: body.type,
				url: `${server.url.origin}/a/${Buffer.from(key).toString("base64url")}`,
			} as const;
			artifacts.set(key, artifact);
			return Response.json(
				{ publishedAt: artifact.publishedAt, url: artifact.url },
				{ status: created ? 201 : 200 }
			);
		},
		hostname: "127.0.0.1",
		port: 0,
	});
	servers.push(server);
	return {
		artifacts,
		failNext: (status: number, body: unknown): void => {
			nextFailure = { body, status };
		},
		url: server.url.origin,
	};
};

const runCli = async (
	args: readonly string[],
	environment: Readonly<Record<string, string>>
): Promise<{
	readonly code: number;
	readonly error: string;
	readonly output: string;
}> => {
	const cli = path.resolve(import.meta.dir, "../dist/index.js");
	const child = Bun.spawn(["bun", cli, ...args], {
		env: { ...process.env, ...environment },
		stderr: "pipe",
		stdout: "pipe",
	});
	const output = new Response(child.stdout).text();
	const error = new Response(child.stderr).text();
	return { code: await child.exited, error: await error, output: await output };
};

const envelope = (type: string, payload: unknown, seq: number) =>
	JSON.stringify({
		actor: "a".repeat(64),
		payload,
		seq,
		timestamp: `2026-07-${String(20 + seq).padStart(2, "0")}T12:00:00.000Z`,
		type,
	});

const makeCampaign = async (): Promise<{
	readonly campaign: string;
	readonly config: string;
}> => {
	const root = await mkdtemp(path.join(tmpdir(), "supervillain-cli-publish-"));
	roots.push(root);
	const campaign = path.join(root, "campaign");
	const config = path.join(root, "config");
	await mkdir(path.join(campaign, "characters"), { recursive: true });
	await mkdir(path.join(campaign, "maps"), { recursive: true });
	await writeFile(
		path.join(campaign, "characters", "coda.json"),
		JSON.stringify({
			abilities: [
				{ cost: "3 Drama", name: "Finale", text: "Bring down the house." },
			],
			ancestry: "Human",
			characteristics: {
				agility: 1,
				intuition: 1,
				might: 2,
				presence: 2,
				reason: 0,
			},
			class: "Troubadour",
			heroicResource: "Drama",
			kit: "Punctuation",
			name: "Coda",
			recoveries: 8,
			stamina: 20,
			surges: 1,
			victories: 2,
		})
	);
	const loadedMap = {
		legend: { "#": "wall", ".": "floor" },
		name: "Cavern Mouth",
		rows: ["###", "#.#", "###"],
	};
	await writeFile(
		path.join(campaign, "maps", "cavern.map"),
		"name: Cavern Mouth\n---\n###\n#.#\n###\n"
	);
	await writeFile(
		path.join(campaign, "events.jsonl"),
		`${[
			envelope("core.room-created", { gameId: "draw-steel" }, 1),
			envelope(
				"ds.character-entered",
				{
					sheet: {
						abilities: [],
						ancestry: "Human",
						characteristics: {
							agility: 1,
							intuition: 1,
							might: 2,
							presence: 2,
							reason: 0,
						},
						className: "Troubadour",
						heroicResource: "Drama",
						kit: "Punctuation",
						name: "Coda",
						recoveries: 8,
						stamina: 20,
						surges: 1,
						victories: 2,
					},
				},
				2
			),
			envelope("core.map-loaded", loadedMap, 3),
		].join("\n")}\n`
	);
	return { campaign, config };
};

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.stop(true);
	}
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
	);
});

describe("supervillain publish", () => {
	test("publishes character, log, and map snapshot documents through the authenticated web API", async () => {
		const { artifacts, url } = startPublishServer();
		const { campaign, config } = await makeCampaign();
		const environment = { SUPERVILLAIN_WEB: url, XDG_CONFIG_HOME: config };

		for (const [type, name] of [
			["character", "Coda"],
			["log", "villain-room"],
			["map", "Cavern Mouth"],
		] as const) {
			const result = await runCli(
				["publish", type, campaign, name, "--json"],
				environment
			);
			expect(result.code).toBe(0);
			expect(result.error).toBe("");
			expect(JSON.parse(result.output)).toMatchObject({ name, type });
		}

		const character = artifacts.get("character:Coda")?.document;
		expect(character?.artifactType).toBe("character");
		expect(character?.card).toMatchObject({
			description: "Human Troubadour",
			title: "Coda",
		});
		const log = artifacts.get("log:villain-room")?.document;
		expect(log?.artifactType).toBe("log");
		if (log?.artifactType === "log") {
			expect(log.entries.some(({ block }) => block.type === "map-grid")).toBe(
				true
			);
			expect(JSON.stringify(log)).toContain("enters play");
		}
		const map = artifacts.get("map:Cavern Mouth")?.document;
		expect(map?.artifactType).toBe("map");
		expect(map?.card.fields).toContainEqual({
			label: "Dimensions",
			value: "3×3",
		});
	});

	test("lists backend state and revokes with the documented non-interactive confirmation", async () => {
		const { url } = startPublishServer();
		const { campaign, config } = await makeCampaign();
		const environment = { SUPERVILLAIN_WEB: url, XDG_CONFIG_HOME: config };
		await runCli(["publish", "map", campaign, "cavern"], environment);

		const listed = await runCli(["publish", "list", "--json"], environment);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.output).artifacts).toHaveLength(1);
		const revoked = await runCli(
			["publish", "revoke", "map", "cavern", "--yes", "--json"],
			environment
		);
		expect(revoked.code).toBe(0);
		expect(JSON.parse(revoked.output)).toMatchObject({
			name: "cavern",
			type: "map",
		});
		const afterRevoke = await runCli(
			["publish", "list", "--json"],
			environment
		);
		expect(JSON.parse(afterRevoke.output).artifacts).toEqual([]);
	});

	test("explains structural size failures and linked-identity collisions", async () => {
		const { failNext, url } = startPublishServer();
		const { campaign, config } = await makeCampaign();
		const environment = { SUPERVILLAIN_WEB: url, XDG_CONFIG_HOME: config };
		failNext(413, {
			error: {
				code: "snapshot-too-large",
				limitBytes: 10 * 1024 * 1024,
				message: "Snapshot document exceeds the 10 MB publish limit.",
			},
		});
		const tooLarge = await runCli(
			["publish", "map", campaign, "Cavern Mouth"],
			environment
		);
		expect(tooLarge.error).toContain("10 MB artifact limit");

		const firstUrl = `${url}/a/${"A".repeat(43)}`;
		const secondUrl = `${url}/a/${"B".repeat(43)}`;
		failNext(409, {
			error: {
				code: "linked-artifact-collision",
				message: "Linked identities own more than one artifact.",
				urls: [firstUrl, secondUrl],
			},
		});
		const collision = await runCli(
			["publish", "map", campaign, "Cavern Mouth"],
			environment
		);
		expect(collision.error).toContain(firstUrl);
		expect(collision.error).toContain(secondUrl);
		expect(collision.error).toContain(
			`supervillain publish revoke map 'Cavern Mouth' --capability ${firstUrl} --yes`
		);
	});

	test("reports an offline backend in one line without a stack trace", async () => {
		const { config } = await makeCampaign();
		const result = await runCli(
			["publish", "list", "--web", "http://127.0.0.1:1"],
			{ XDG_CONFIG_HOME: config }
		);
		expect(result.code).toBe(1);
		expect(result.output).toBe("");
		expect(result.error).toBe(
			"Could not reach the publish service. publish list requires a network connection.\n"
		);
	});
});
