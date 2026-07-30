/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun-only suite; the gateway is Bun-bound by bun:sqlite. */
import { expect, test } from "bun:test";

import { requireInteractiveShell } from "../src/index.js";

interface ShellGateProbe {
	readonly session: Parameters<typeof requireInteractiveShell>[0];
	readonly bytes: () => Buffer;
	readonly ended: () => boolean;
}

const shellGateProbe = (hasPty: boolean): ShellGateProbe => {
	const writes: Buffer[] = [];
	let ended = false;
	return {
		bytes: () => Buffer.concat(writes),
		ended: () => ended,
		session: {
			end() {
				ended = true;
			},
			hasPty,
			write(data) {
				writes.push(Buffer.from(data));
			},
		},
	};
};

test("a no-PTY shell writes only the honesty notice and closes before rendering", () => {
	const probe = shellGateProbe(false);
	// @opentui/ssh constructs the renderer only after middleware calls `next`.
	let rendererConstructions = 0;

	expect(() =>
		requireInteractiveShell(probe.session, () => {
			rendererConstructions += 1;
		})
	).toThrow("session denied");

	expect(probe.bytes()).toEqual(
		Buffer.from(
			"this door is interactive; run ssh -t, or use the CLI for scripts\r\n"
		)
	);
	expect(probe.ended()).toBe(true);
	expect(rendererConstructions).toBe(0);
});

test("a PTY shell enters the existing renderer path unchanged", () => {
	const probe = shellGateProbe(true);
	const lobby = { kind: "lobby" } as const;
	let rendererConstructions = 0;

	const result = requireInteractiveShell(probe.session, () => {
		rendererConstructions += 1;
		return lobby;
	});

	expect(result).toBe(lobby);
	expect(rendererConstructions).toBe(1);
	expect(probe.bytes()).toEqual(Buffer.alloc(0));
	expect(probe.ended()).toBe(false);
});
