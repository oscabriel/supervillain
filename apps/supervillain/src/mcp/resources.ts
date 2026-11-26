import {
	cardLines,
	GM,
	helpText,
	isRefused,
	listIfDefined,
	notInParty,
	sheetOf,
	sheetTargetFor,
	stagedCardOf,
} from "@supervillain/domain";
import { Context, Effect, FileSystem, Path, Schema, Scope } from "effect";
import { McpSchema, McpServer } from "effect/ai";

import { readBounded, utf8Of } from "../content/bounded.ts";
import { CampaignContent, docsOf, MAP_BYTES } from "../content/index.ts";
import type { ContentIndex } from "../content/index.ts";
import { MD_BYTES } from "../content/kinds.ts";
import { ContentWatch } from "../host/ContentWatch.ts";
import { TableRoom } from "../host/TableRoom.ts";
import { PARAM_MOST, tooLong } from "./limits.ts";
import type { Gate } from "./limits.ts";
import { contentSchemaText } from "./schema.ts";
import type { McpSeat, McpServices } from "./seat.ts";
import { FEED_DEFAULT, viewOf } from "./view.ts";
import type { SeatView } from "./view.ts";

export class ResourceMissing extends Schema.TaggedError<ResourceMissing>()(
	"ResourceMissing",
	{ message: Schema.String }
) {}

export class ResourceRefused extends Schema.TaggedError<ResourceRefused>()(
	"ResourceRefused",
	{ message: Schema.String }
) {}

const within = (name: string, value: string) =>
	value.length > PARAM_MOST
		? Effect.fail(new ResourceRefused({ message: tooLong(name, PARAM_MOST) }))
		: Effect.void;

const SCHEME = "supervillain://";

const TEXT = "text/plain";

const JSON_TYPE = "application/json";

const MARKDOWN = "text/markdown";

type CampaignEntry = Pick<CampaignFile, "kind" | "id" | "file" | "uri">;

const json = (value: SeatView | ReadonlyArray<CampaignEntry>): string =>
	JSON.stringify(value, null, 2);

const Who = McpSchema.param("who", Schema.String);

const Key = McpSchema.param("key", Schema.String);

const Kind = McpSchema.param("kind", Schema.String);

const Id = McpSchema.param("id", Schema.String);

const sheetText = (seat: McpSeat, who: string) =>
	Effect.gen(function* () {
		const state = yield* (yield* TableRoom).state;
		const { ruleset } = yield* CampaignContent;

		const target =
			seat.role === "gm"
				? who
				: sheetTargetFor(state, seat.actor, who, ruleset);

		if (target === undefined) {
			return yield* new ResourceMissing({ message: notInParty(who) });
		}

		const text = sheetOf(state, target, ruleset);

		return isRefused(text)
			? yield* new ResourceMissing({ message: text.refusal })
			: text;
	});

const codexCard = (seat: McpSeat, key: string) =>
	Effect.gen(function* () {
		const state = yield* (yield* TableRoom).state;
		const card = stagedCardOf(state, key);

		if (card === undefined) {
			return yield* new ResourceMissing({
				message: `No card for "${key}" is in the table's codex.`,
			});
		}

		const lines = cardLines(card).join("\n");

		if (seat.actor !== GM) {
			return lines;
		}

		const notes = yield* (yield* CampaignContent).gmNotes(card.key);

		return notes === undefined
			? lines
			: `${lines}\n\nGM notes (only you see these):\n${notes}`;
	});

interface CampaignFile {
	readonly kind: string;
	readonly id: string;
	readonly file: string;
	readonly uri: string;
	readonly maxBytes: number;
}

const campaignFile = (
	kind: string,
	id: string,
	file: string,
	maxBytes: number
): CampaignFile => ({
	kind,
	id,
	file,
	uri: `${SCHEME}campaign/${kind}/${id}`,
	maxBytes,
});

const filesOf = (index: ContentIndex): ReadonlyArray<CampaignFile> => [
	...listIfDefined(index.table, (table) => [
		campaignFile("table", "table", table.file, MD_BYTES),
	]),
	...docsOf(index).map((doc) =>
		campaignFile(doc.kind, doc.id, doc.file, MD_BYTES)
	),
	...index.maps.map((id) =>
		campaignFile("map", id, `maps/${id}.txt`, MAP_BYTES)
	),
];

const campaignText = (kind: string, id: string) =>
	Effect.gen(function* () {
		const index = yield* (yield* ContentWatch).index.get;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const found = filesOf(index).find((f) => f.kind === kind && f.id === id);

		if (found === undefined) {
			return yield* new ResourceMissing({
				message: `The campaign has no ${kind} called "${id}"; supervillain://campaign/files lists them.`,
			});
		}

		const read = yield* readBounded(
			fs,
			path.join(index.dir, found.file),
			found.maxBytes
		);

		const text = read.ok ? utf8Of(read.bytes) : undefined;

		return (
			text ??
			(yield* new ResourceMissing({
				message: `${found.file} ${read.ok ? "isn't UTF-8 text" : read.problem}.`,
			}))
		);
	});

const schemaText = (kind: string) =>
	Effect.gen(function* () {
		const { ruleset } = yield* CampaignContent;
		const text = contentSchemaText(ruleset, kind);

		return (
			text ??
			(yield* new ResourceMissing({
				message: `There's no schema for "${kind}".`,
			}))
		);
	});

type Refusable = ResourceMissing | ResourceRefused;

export const registerResources = (seat: McpSeat, gate: Gate) =>
	Effect.gen(function* () {
		const services = Context.omit(Scope.Scope)(
			yield* Effect.context<McpServices>()
		);

		const provided = <A>(effect: Effect.Effect<A, Refusable, McpServices>) =>
			Effect.provideContext(
				gate.admit(effect, (said) =>
					Effect.fail(new ResourceRefused({ message: said }))
				),
				services
			);

		const { ruleset } = yield* CampaignContent;

		yield* McpServer.registerResource({
			uri: `${SCHEME}help`,
			name: "help",
			description:
				"The table's help: every command this campaign's rules take.",
			mimeType: TEXT,
			content: provided(
				Effect.succeed(helpText(seat.actor, undefined, "exec", ruleset))
			),
		});

		yield* McpServer.registerResource({
			uri: `${SCHEME}table/state`,
			name: "table state",
			description:
				"What your seat sees right now, as get_table_state returns it.",
			mimeType: JSON_TYPE,
			content: provided(
				Effect.map(viewOf(seat, FEED_DEFAULT), (view) => json(view))
			),
		});

		yield* McpServer.registerResource`supervillain://sheet/${Who}`({
			name: "sheet",
			description:
				seat.role === "gm"
					? "Anyone's sheet at the table, by name or id."
					: "A party member's sheet, by name or id.",
			mimeType: TEXT,
			content: (_uri, who) =>
				provided(Effect.andThen(within("who", who), sheetText(seat, who))),
		});

		yield* McpServer.registerResource`supervillain://codex/${Key}`({
			name: "codex card",
			description:
				"A card the GM has shown or revealed to the table, by its key (like npc:old-mara).",
			mimeType: TEXT,
			content: (_uri, key) =>
				provided(Effect.andThen(within("key", key), codexCard(seat, key))),
		});

		if (seat.role !== "gm") {
			return;
		}

		yield* McpServer.registerResource({
			uri: `${SCHEME}campaign/files`,
			name: "campaign files",
			description:
				"Every campaign file the table reads, with the URI that reads each.",
			mimeType: JSON_TYPE,
			content: provided(
				Effect.gen(function* () {
					const index = yield* (yield* ContentWatch).index.get;

					return json(
						filesOf(index).map(({ kind, id, file, uri }) => ({
							kind,
							id,
							file,
							uri,
						}))
					);
				})
			),
		});

		yield* McpServer.registerResource`supervillain://campaign/${Kind}/${Id}`({
			name: "campaign file",
			description:
				"One campaign file as written, GM notes and all: its kind (table, scene, npc, map…) and id.",
			mimeType: MARKDOWN,
			content: (_uri, kind, id) =>
				provided(
					Effect.andThen(
						Effect.andThen(within("kind", kind), within("id", id)),
						campaignText(kind, id)
					)
				),
		});

		yield* McpServer.registerResource`supervillain://schema/${Kind}`({
			name: "content schema",
			description:
				"The JSON Schema for one kind of campaign file's frontmatter (table, scene, npc, handout, …).",
			mimeType: JSON_TYPE,
			content: (_uri, kind) =>
				provided(Effect.andThen(within("kind", kind), schemaText(kind))),
		});
	});
