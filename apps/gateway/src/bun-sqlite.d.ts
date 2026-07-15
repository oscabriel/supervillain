/** The narrow slice of `bun:sqlite` the gateway uses, declared locally so the
 * workspace keeps a single Node types lineage (bun-types 1.3 conflicts with
 * the workspace's Node 24 type set). Only the gateway may import bun:sqlite —
 * lattice-enforced. */
declare module "bun:sqlite" {
	export interface Statement {
		readonly get: (params?: Record<string, string | number>) => unknown;
		readonly run: (params?: Record<string, string | number>) => void;
	}

	export class Database {
		constructor(
			path: string,
			options?: { readonly create?: boolean; readonly strict?: boolean }
		);
		query(sql: string): Statement;
		run(sql: string): void;
		transaction<T>(fn: () => T): () => T;
		close(): void;
	}
}
