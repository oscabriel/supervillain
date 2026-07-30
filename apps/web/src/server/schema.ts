import { getTableName, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import {
	blob,
	check,
	getTableConfig,
	SQLiteSyncDialect,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

type BunSQLiteClient = ReturnType<typeof drizzle>["$client"];

const ARTIFACT_TYPES = ["character", "log", "map"] as const;

/** Drizzle is the typed query schema only. SQL migrations remain authoritative. */
export const publishedArtifacts = sqliteTable(
	"published_artifacts",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		ownerIdentity: text("owner_identity").notNull(),
		publishedAt: text("published_at").notNull(),
		snapshotPath: text("snapshot_path").notNull(),
		type: text("type", { enum: ARTIFACT_TYPES }).notNull(),
	},
	(table) => [
		uniqueIndex("published_artifacts_owner_type_name_unique").on(
			table.ownerIdentity,
			table.type,
			table.name
		),
		check(
			"published_artifacts_type_check",
			sql`${table.type} IN ('character', 'log', 'map')`
		),
	]
);

export const capabilityTokens = sqliteTable(
	"capability_tokens",
	{
		artifactId: text("artifact_id")
			.primaryKey()
			.references(() => publishedArtifacts.id, { onDelete: "cascade" }),
		seed: blob("seed", { mode: "buffer" }).notNull(),
		tokenHash: blob("token_hash", { mode: "buffer" }).notNull(),
	},
	(table) => [
		uniqueIndex("capability_tokens_token_hash_unique").on(table.tokenHash),
		check("capability_tokens_seed_length", sql`length(${table.seed}) = 32`),
		check(
			"capability_tokens_hash_length",
			sql`length(${table.tokenHash}) = 32`
		),
	]
);

export const deadTokenTombstones = sqliteTable(
	"dead_token_tombstones",
	{
		revokedAt: text("revoked_at").notNull(),
		tokenHash: blob("token_hash", { mode: "buffer" }).primaryKey(),
	},
	(table) => [
		check(
			"dead_token_tombstones_hash_length",
			sql`length(${table.tokenHash}) = 32`
		),
	]
);

/** One version step creates the backend's complete ADR-0013 durable list. */
export const MIGRATIONS: readonly string[] = [
	`CREATE TABLE published_artifacts (
		id TEXT PRIMARY KEY,
		owner_identity TEXT NOT NULL,
		type TEXT NOT NULL,
		name TEXT NOT NULL,
		snapshot_path TEXT NOT NULL,
		published_at TEXT NOT NULL,
		CONSTRAINT published_artifacts_type_check CHECK (type IN ('character', 'log', 'map'))
	) STRICT;
	CREATE UNIQUE INDEX published_artifacts_owner_type_name_unique
		ON published_artifacts (owner_identity, type, name);
	CREATE TABLE capability_tokens (
		artifact_id TEXT PRIMARY KEY REFERENCES published_artifacts(id) ON DELETE CASCADE,
		seed BLOB NOT NULL,
		token_hash BLOB NOT NULL,
		CONSTRAINT capability_tokens_seed_length CHECK (length(seed) = 32),
		CONSTRAINT capability_tokens_hash_length CHECK (length(token_hash) = 32)
	) STRICT;
	CREATE UNIQUE INDEX capability_tokens_token_hash_unique
		ON capability_tokens (token_hash);
	CREATE TABLE dead_token_tombstones (
		token_hash BLOB PRIMARY KEY,
		revoked_at TEXT NOT NULL,
		CONSTRAINT dead_token_tombstones_hash_length CHECK (length(token_hash) = 32)
	) STRICT`,
];

interface TableInfoRow {
	readonly dflt_value: string | null;
	readonly name: string;
	readonly notnull: number;
	readonly pk: number;
	readonly type: string;
}

interface IndexListRow {
	readonly name: string;
	readonly origin: string;
	readonly unique: number;
}

interface IndexInfoRow {
	readonly name: string;
	readonly seqno: number;
}

interface ForeignKeyRow {
	readonly from: string;
	readonly on_delete: string;
	readonly table: string;
	readonly to: string;
}

interface SchemaObjectRow {
	readonly name: string;
	readonly sql: string;
}

interface TableListRow {
	readonly name: string;
	readonly strict: number;
}

interface UserVersionRow {
	readonly user_version: number;
}

const tableConfigs = [
	getTableConfig(publishedArtifacts),
	getTableConfig(capabilityTokens),
	getTableConfig(deadTokenTombstones),
] as const;

const formatColumns = (
	columns: readonly {
		readonly name: string;
		readonly notNull: boolean;
		readonly primary: boolean;
		readonly sqlType: string;
	}[]
): string =>
	columns
		.map(
			({ name, notNull, primary, sqlType }) =>
				`${name}:${sqlType}:${notNull ? "not-null" : "nullable"}:${primary ? "pk" : "plain"}`
		)
		.toSorted()
		.join(",");

const indexSignature = (
	name: string,
	unique: boolean,
	columns: readonly string[]
): string => `${name}:${unique ? "unique" : "plain"}:${columns.join(",")}`;

const foreignKeySignature = (
	from: string,
	table: string,
	to: string,
	onDelete: string
): string => `${from}->${table}.${to}:${onDelete.toLowerCase()}`;

const failDrift = (detail: string): never => {
	throw new Error(`Schema drift between Drizzle and migrations: ${detail}`);
};

const normalizeCheckSql = (value: string): string =>
	value
		.toLowerCase()
		.replaceAll(/"[^"]+"\."(?<column>[^"]+)"/gu, "$<column>")
		.replaceAll(/["\s]/gu, "");

/**
 * Compares every Drizzle table, column, index, foreign key, and named check to
 * the schema the user-version migrations actually produced. Called on every
 * store open so drift is a startup failure rather than latent query damage.
 */
export const assertSchemaMatchesMigrations = (
	sqlite: BunSQLiteClient
): void => {
	const version = sqlite.query("PRAGMA user_version").get() as UserVersionRow;
	if (version.user_version !== MIGRATIONS.length) {
		failDrift(
			`user_version expected ${MIGRATIONS.length} but found ${version.user_version}`
		);
	}
	const actualTables = sqlite
		.query(
			"SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all() as readonly SchemaObjectRow[];
	const expectedNames = tableConfigs.map(({ name }) => name).toSorted();
	const actualNames = actualTables.map(({ name }) => name);
	if (actualNames.join(",") !== expectedNames.join(",")) {
		failDrift(`tables expected [${expectedNames}] but found [${actualNames}]`);
	}
	const tableList = sqlite
		.query("PRAGMA table_list")
		.all() as readonly TableListRow[];
	for (const name of expectedNames) {
		if (tableList.find((table) => table.name === name)?.strict !== 1) {
			failDrift(`${name} is not STRICT`);
		}
	}
	const dialect = new SQLiteSyncDialect();

	for (const config of tableConfigs) {
		const expectedColumns = config.columns.map((column) => ({
			name: column.name,
			notNull: column.notNull,
			primary: column.primary,
			sqlType: column.getSQLType().toUpperCase(),
		}));
		const tableInfo = sqlite
			.query(`PRAGMA table_info('${config.name}')`)
			.all() as readonly TableInfoRow[];
		const actualColumns = tableInfo.map((column) => ({
			name: column.name,
			notNull: column.notnull === 1 || column.pk > 0,
			primary: column.pk > 0,
			sqlType: column.type.toUpperCase(),
		}));
		const expectedColumnSignature = formatColumns(expectedColumns);
		const actualColumnSignature = formatColumns(actualColumns);
		if (actualColumnSignature !== expectedColumnSignature) {
			failDrift(
				`${config.name} columns expected [${expectedColumnSignature}] but found [${actualColumnSignature}]`
			);
		}
		const unexpectedDefault = tableInfo.find(
			({ dflt_value: value }) => value !== null
		);
		if (unexpectedDefault) {
			failDrift(
				`${config.name}.${unexpectedDefault.name} has an unexpected default`
			);
		}

		const expectedIndexes = config.indexes
			.map(({ config: index }) =>
				indexSignature(
					index.name,
					index.unique,
					index.columns.map((column) => {
						const name = "name" in column ? column.name : undefined;
						if (typeof name !== "string") {
							throw new TypeError(
								`Schema drift between Drizzle and migrations: ${config.name} has an expression index`
							);
						}
						return name;
					})
				)
			)
			.toSorted();
		const actualIndexes = (
			sqlite
				.query(`PRAGMA index_list('${config.name}')`)
				.all() as readonly IndexListRow[]
		)
			.filter(({ origin }) => origin === "c")
			.map((index) => {
				const columns = (
					sqlite
						.query(`PRAGMA index_info('${index.name}')`)
						.all() as readonly IndexInfoRow[]
				)
					.toSorted((left, right) => left.seqno - right.seqno)
					.map(({ name }) => name);
				return indexSignature(index.name, index.unique === 1, columns);
			})
			.toSorted();
		if (actualIndexes.join("|") !== expectedIndexes.join("|")) {
			failDrift(
				`${config.name} indexes expected [${expectedIndexes}] but found [${actualIndexes}]`
			);
		}

		const expectedForeignKeys = config.foreignKeys
			.flatMap((foreignKey) => {
				const reference = foreignKey.reference();
				return reference.columns.map((column, index) => {
					const target = reference.foreignColumns[index];
					if (!target) {
						return failDrift(`${config.name} has an incomplete foreign key`);
					}
					return foreignKeySignature(
						column.name,
						getTableName(reference.foreignTable),
						target.name,
						foreignKey.onDelete ?? "no action"
					);
				});
			})
			.toSorted();
		const actualForeignKeys = (
			sqlite
				.query(`PRAGMA foreign_key_list('${config.name}')`)
				.all() as readonly ForeignKeyRow[]
		)
			.map((foreignKey) =>
				foreignKeySignature(
					foreignKey.from,
					foreignKey.table,
					foreignKey.to,
					foreignKey.on_delete
				)
			)
			.toSorted();
		if (actualForeignKeys.join("|") !== expectedForeignKeys.join("|")) {
			failDrift(
				`${config.name} foreign keys expected [${expectedForeignKeys}] but found [${actualForeignKeys}]`
			);
		}

		const ddl = actualTables.find(({ name }) => name === config.name)?.sql;
		if (ddl === undefined) {
			throw new Error(
				`Schema drift between Drizzle and migrations: ${config.name} has no CREATE TABLE SQL`
			);
		}
		const normalizedDdl = normalizeCheckSql(ddl);
		for (const constraint of config.checks) {
			const expression = normalizeCheckSql(
				dialect.sqlToQuery(constraint.value).sql
			);
			if (
				!ddl.includes(constraint.name) ||
				!normalizedDdl.includes(expression)
			) {
				failDrift(`${config.name} has drifted check ${constraint.name}`);
			}
		}
	}
};
