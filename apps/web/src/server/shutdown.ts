import { defineNitroPlugin } from "nitro/runtime";

/**
 * SIGTERM honesty (#43 spike, carried into ADR-0020): nitro's `bun` preset
 * entry is a bare `Bun.serve` with **no signal handling** — under systemd a
 * stop would be an instant kill (exit 143) that drops in-flight requests.
 * This plugin is the spike's documented ten-line fix: drain via nitro's
 * close hook, then exit 0.
 */
export default defineNitroPlugin((nitroApp) => {
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, async () => {
			try {
				await nitroApp.hooks.callHook("close");
			} catch (error) {
				console.error("graceful shutdown hook failed:", error);
			}
			process.exit(0);
		});
	}
});
