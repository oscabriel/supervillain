import type { Database } from "bun:sqlite";

/** Applies the migrations `PRAGMA user_version` has not seen yet, in order.
 * Each entry is one version step; the array only ever grows. */
export const migrate = (db: Database, migrations: readonly string[]): void => {
	const row = db.query("PRAGMA user_version").get() as {
		readonly user_version: number;
	};
	for (
		let version = row.user_version;
		version < migrations.length;
		version += 1
	) {
		const step = migrations[version];
		if (step !== undefined) {
			db.transaction(() => {
				db.run(step);
				db.run(`PRAGMA user_version = ${version + 1}`);
			})();
		}
	}
};
