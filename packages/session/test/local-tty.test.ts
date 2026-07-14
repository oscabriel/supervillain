import { describe, expect, test } from "bun:test";
/* oxlint-disable unicorn/prefer-event-target, vitest/prefer-importing-vitest-globals -- Node stream stand-ins intentionally mirror EventEmitter streams. */
import { EventEmitter } from "node:events";

import { attachLocalTty } from "../src/index.js";

const streams = () => {
	const input = new EventEmitter() as NodeJS.ReadStream;
	const output = new EventEmitter() as NodeJS.WriteStream;
	return { input, output };
};

describe("attachLocalTty", () => {
	test("reads terminal size with an 80 by 24 fallback", () => {
		const { input, output } = streams();
		const session = attachLocalTty({ actor: "actor", input, output });
		expect(session.size()).toEqual({ columns: 80, rows: 24 });
		Object.assign(output, { columns: 120, rows: 40 });
		expect(session.size()).toEqual({ columns: 120, rows: 40 });
	});

	test("subscribes and unsubscribes resize listeners", () => {
		const { input, output } = streams();
		const session = attachLocalTty({ actor: "actor", input, output });
		const sizes: unknown[] = [];
		const unsubscribe = session.onResize((size) => sizes.push(size));
		output.emit("resize");
		unsubscribe();
		output.emit("resize");
		expect(sizes).toEqual([{ columns: 80, rows: 24 }]);
	});

	test("closes idempotently and fires close listeners once", () => {
		const { input, output } = streams();
		const session = attachLocalTty({ actor: "actor", input, output });
		let closes = 0;
		session.onClose(() => {
			closes += 1;
		});
		session.close();
		session.close();
		expect(closes).toBe(1);
	});
});
