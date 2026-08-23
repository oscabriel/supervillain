// PROTOTYPE — THROWAWAY (not production code; no tests by design).
//
/* oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- the kitty placeholder packs the image ID into the fg channels by bit arithmetic (protocol contract). */
/* oxlint-disable unicorn/escape-case, unicorn/no-hex-escape -- ANSI/kitty bytes are written \x1b and hex throughout the protocol documents; another notation breaks greppability against them. */
/* oxlint-disable eslint/sort-keys -- object literals keep the protocol's own field order. */
/* oxlint-disable eslint/curly -- prototype-grade single-statement branches stay braceless. */
/* oxlint-disable promise/prefer-await-to-callbacks, promise/avoid-new, eslint/no-promise-executor-return -- stream callbacks and hand-rolled sleeps are the harness here; promisifying them hides what the renderer schedules. */
/* oxlint-disable eslint/func-style, unicorn/text-encoding-identifier-case, unicorn/prefer-spread, eslint/no-inline-comments, import/consistent-type-specifier-style, anti-slop/no-unknown-parameters -- throwaway harness style; the product-side rules these mirror are enforced in src/, not here. */
/* oxlint-disable eslint/max-classes-per-file, eslint/no-useless-constructor, anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening -- the harness needs one collector stream beside the placeholder renderable, a trivial subclass constructor, and renderer internals that only surface through casts. */
// Question: does ADR-0032's committed placement mechanism actually work —
// kitty Unicode placeholders (U+10EEEE cells whose fg color encodes the image
// ID) written through OpenTUI's own buffer, so diffing, z-order, and scissor
// clipping give us occlusion for free (no occlusion manager, no occluder-rect
// registration)? The migrated product shipped the classic `a=p` fallback
// because that is what the first prototype validated live; this experiment is
// what #134 owes before the ADR can be called conformant.
//
// It answers four things:
//   Q1  Do placeholder cells survive OpenTUI's frame diff byte-exactly
//       (codepoint + truecolor fg), and do unchanged ones emit nothing?
//   Q2  Does z-order occlusion restore for free — cover placeholders with a
//       higher-z box, move it away, and are the freed cells re-emitted by the
//       ordinary next-frame diff?
//   Q3  Does scissor clipping suppress out-of-bounds placeholder writes?
//   Q4  (TTY leg, you drive) Does a real terminal (Ghostty) paint the
//       transmitted image *under* the placeholder cells and restore cleanly
//       as the occluder moves?
//
// Run (headless — byte-level verdicts, no terminal needed):
//           bun packages/table/prototype/u10eeee-placeholders.ts --headless
// Run (TTY — in Ghostty; arrows move the occluder, q quits):
//           bun packages/table/prototype/u10eeee-placeholders.ts
// Non-TTY default is headless.

import { PassThrough, Writable } from "node:stream";
import {
	CliRenderer,
	Renderable,
	BoxRenderable,
	RGBA,
	createCliRenderer,
	type OptimizedBuffer,
	type RenderableOptions,
	type RenderContext,
} from "@opentui/core";
import {
	deleteImageSequence,
	transmitSequences,
	Framebuffer,
} from "../src/map-kitty.ts";

// ---------------------------------------------------------------------------
// Kitty Unicode-placeholder encoding (small-ID spelling): U+10EEEE with the
// image ID packed into the 24-bit foreground color.
// ---------------------------------------------------------------------------

const PLACEHOLDER = "\u{10EEEE}";
const IMAGE_ID = 1;
const idFg = (id: number): RGBA =>
	RGBA.fromInts((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
const PLACEHOLDER_UTF8 = Buffer.from(PLACEHOLDER, "utf8");

// ---------------------------------------------------------------------------
// Headless harness — mirrors opentui's own renderer.custom-stdout test setup:
// a fake stdin + collecting stdout, so the feed-backed path emits real frame
// bytes into `writes`.
// ---------------------------------------------------------------------------

class CollectingStdout extends Writable {
	public readonly isTTY = true;
	public readonly columns = 80;
	public readonly rows = 24;
	public readonly writes: Buffer[] = [];
	override _write(
		chunk: unknown,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void
	): void {
		this.writes.push(
			Buffer.isBuffer(chunk)
				? Buffer.from(chunk)
				: Buffer.from((chunk as Uint8Array).slice())
		);
		callback();
	}
	getWrittenBytes(): Buffer {
		return Buffer.concat(this.writes);
	}
	clearWrites(): void {
		this.writes.length = 0;
	}
}

const createTestStdin = (): NodeJS.ReadStream =>
	new PassThrough() as unknown as NodeJS.ReadStream;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Count placeholder occurrences in a byte window and capture their fg SGR. */
const analyzeWindow = (
	bytes: Buffer
): { count: number; fgs: Set<string> } => {
	const fgs = new Set<string>();
	let count = 0;
	let at = bytes.indexOf(PLACEHOLDER_UTF8);
	while (at !== -1) {
		count += 1;
		const sgrStart = bytes.lastIndexOf("\x1b[38;2;", at);
		if (sgrStart !== -1) {
			const sgrEnd = bytes.indexOf("m", sgrStart);
			if (sgrEnd !== -1 && sgrEnd < at) {
				fgs.add(bytes.toString("latin1", sgrStart, sgrEnd + 1));
			}
		}
		at = bytes.indexOf(PLACEHOLDER_UTF8, at + PLACEHOLDER_UTF8.length);
	}
	return { count, fgs };
};

// ---------------------------------------------------------------------------
// The placeholder map renderable: one U+10EEEE cell per grid position, fg =
// image ID, drawn straight into the screen buffer (non-buffered, so absolute
// coords are real inside renderSelf).
// ---------------------------------------------------------------------------

class PlaceholderMap extends Renderable {
	constructor(
		ctx: RenderContext,
		options: RenderableOptions<PlaceholderMap>
	) {
		super(ctx, options);
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		const fg = idFg(IMAGE_ID);
		const bg = RGBA.fromInts(0, 0, 0);
		for (let y = this._screenY; y < this._screenY + this.height; y += 1) {
			for (let x = this._screenX; x < this._screenX + this.width; x += 1) {
				buffer.setCell(x, y, PLACEHOLDER, fg, bg);
			}
		}
	}
}

const GRID = { x: 2, y: 2, w: 40, h: 10 };
const CELL_TOTAL = GRID.w * GRID.h;
const EXPECTED_FG = `\x1b[38;2;0;0;${IMAGE_ID}m`;

interface Verdict {
	name: string;
	pass: boolean;
	detail: string;
}

const verdicts: Verdict[] = [];
const windowContains = (bytes: Buffer, needle: string): boolean =>
	bytes.includes(Buffer.from(needle, "latin1"));
const judge = (name: string, pass: boolean, detail: string): void => {
	verdicts.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

// ---------------------------------------------------------------------------
// Headless experiment: the scripted frame sequence through the real renderer.
// ---------------------------------------------------------------------------

async function headless(): Promise<number> {
	const stdout = new CollectingStdout();
	const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
		consoleMode: "disabled",
	});
	const snap = async (): Promise<{
		count: number;
		fgs: Set<string>;
		raw: number;
		bytes: Buffer;
	}> => {
		await sleep(120); // let the feed pipe drain into our collector
		const window = stdout.getWrittenBytes();
		stdout.clearWrites();
		const { count, fgs } = analyzeWindow(window);
		return { count, fgs, raw: window.length, bytes: window };
	};

	// F0: initial full-grid frame.
	// F0: initial full-grid frame. NOTE: x/y are properties, not constructor
	// options — passing them in the options object is silently dropped.
	const map = new PlaceholderMap(renderer, {
		width: GRID.w,
		height: GRID.h,
		zIndex: 1,
	});
	map.position = "absolute";
	map.x = GRID.x;
	map.y = GRID.y;
	renderer.root.add(map);
	renderer.requestRender();
	const f0 = await snap();
	judge(
		"Q1a full-grid emit",
		f0.count === CELL_TOTAL && f0.fgs.has(EXPECTED_FG),
		`${f0.count}/${CELL_TOTAL} placeholder cells emitted, fg SGRs: ${[...f0.fgs].join(" ") || "(none)"}`
	);

	// F1: no change → the diff must emit nothing.
	renderer.requestRender();
	const f1 = await snap();
	judge(
		"Q1b no-op silence",
		f1.count === 0 && f1.raw === 0,
		`${f1.count} placeholder cells, ${f1.raw} total bytes on an unchanged frame`
	);

	// F2: an occluder box covers the left half of the grid. Covered cells are
	// overwritten by the higher-z box (painter's algorithm): they emit as box
	// fill cells, NOT placeholders — so zero placeholders should leak through,
	// while the box's own background SGR proves it painted the covered cells.
	const box = new BoxRenderable(renderer, {
		width: GRID.w / 2,
		height: GRID.h,
		backgroundColor: RGBA.fromInts(120, 30, 30),
		shouldFill: true,
		zIndex: 5,
	});
	box.position = "absolute";
	box.x = GRID.x;
	box.y = GRID.y;
	renderer.root.add(box);
	const BOX_BG = "\x1b[48;2;120;30;30m";
	renderer.requestRender();
	const f2 = await snap();
	judge(
		"Q2a cover left half",
		f2.count === 0 && f2.raw > 0 && windowContains(f2.bytes, BOX_BG),
		`${f2.count} placeholder cells leaked through the cover (expected 0); ${BOX_BG} present ⇒ the box painted its covered cells`
	);

	// F3: move the box to the right half — freed cells must come back via the
	// plain recompose+diff, which is the entire "occlusion for free" claim:
	// exactly half the grid re-emits as placeholders (the freed left half),
	// while the newly covered right half emits as box fill again.
	box.x = GRID.x + GRID.w / 2;
	renderer.requestRender();
	const f3 = await snap();
	judge(
		"Q2b free restore on move",
		f3.count === CELL_TOTAL / 2 && windowContains(f3.bytes, BOX_BG),
		`${f3.count} placeholder cells restored (freed left half, expected ${CELL_TOTAL / 2}); box bg present ⇒ right half stays covered`
	);

	// F4: remove the box entirely — the freed right half reverts in one diff;
	// the left half was already restored in F3 and must stay silent.
	renderer.root.remove(box);
	renderer.requestRender();
	const f4 = await snap();
	judge(
		"Q2c free restore on remove",
		f4.count === CELL_TOTAL / 2 && f4.fgs.has(EXPECTED_FG),
		`${f4.count} placeholder cells re-emitted (freed right half, expected ${CELL_TOTAL / 2})`
	);

	// Q3: scissor — a hidden-overflow container clips its child's placeholders.
	const clip = new BoxRenderable(renderer, {
		width: 10,
		height: 4,
		overflow: "hidden",
		shouldFill: true,
		zIndex: 1,
	});
	clip.position = "absolute";
	clip.x = GRID.x;
	clip.y = GRID.y + GRID.h + 1;
	const clipped = new PlaceholderMap(renderer, {
		width: GRID.w,
		height: GRID.h,
		zIndex: 2,
	});
	clip.add(clipped);
	renderer.root.add(clip);
	renderer.requestRender();
	const f5 = await snap();
	judge(
		"Q3 scissor suppression",
		f5.count === 40 && f5.raw > 0,
		`${f5.count} placeholder cells emitted from a 40-cell viewport of a ${CELL_TOTAL}-cell child (expected exactly 40)`
	);

	await renderer.destroy();

	const failed = verdicts.filter((v) => !v.pass).length;
	console.log(
		`\n${verdicts.length - failed}/${verdicts.length} checks passed — ${failed === 0 ? "placeholders ride OpenTUI's diff/z-order/scissor untouched" : "see failures above"}`
	);
	return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// TTY leg: transmit image 1, then drive the placeholder grid live. You answer
// the only question bytes cannot: does your terminal paint the image *under*
// U+10EEEE cells and restore cleanly as the occluder moves.
// ---------------------------------------------------------------------------

async function live(): Promise<void> {
	// A small striped framebuffer (8×3 cells at 12×24 metrics): stripes make
	// any misalignment between image and cell grid obvious to the eye.
	const fb = new Framebuffer(96, 72);
	for (let y = 0; y < fb.height; y += 1) {
		for (let x = 0; x < fb.width; x += 1) {
			fb.pixels[(y * fb.width + x) * 4] = (x * 2) % 256;
			fb.pixels[(y * fb.width + x) * 4 + 1] = y % 2 === 0 ? 200 : 60;
			fb.pixels[(y * fb.width + x) * 4 + 2] = (y * 3) % 256;
			fb.pixels[(y * fb.width + x) * 4 + 3] = 255;
		}
	}
	process.stdout.write(transmitSequences(IMAGE_ID, fb).join(""));

	const renderer = await createCliRenderer();

	const box = new BoxRenderable(renderer, {
		width: GRID.w / 2,
		height: GRID.h,
		backgroundColor: RGBA.fromInts(20, 20, 140),
		shouldFill: true,
		zIndex: 5,
	});
	box.position = "absolute";
	box.x = GRID.x;
	box.y = GRID.y;
	renderer.root.add(box);
	renderer.root.add(
		new PlaceholderMap(renderer, { width: GRID.w, height: GRID.h, zIndex: 1 })
	);

	console.log(
		"\x1b[2J\x1b[HPlaceholders live: arrows move the occluder, q quits.\r\n"
		+ "Verdict to eyeball: does the striped image show under the U+10EEEE cells,\r\n"
		+ "and does uncovering restore it without artifacts?"
	);

	await new Promise<void>((resolve) => {
		if (!process.stdin.isTTY) {
			resolve();
			return;
		}
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (chunk: Buffer) => {
			const key = chunk.toString("latin1");
			const step = (dx: number, dy: number): void => {
				box.x = Math.max(0, Math.min(78 - GRID.w / 2, box.x + dx));
				box.y = Math.max(0, Math.min(22 - GRID.h, box.y + dy));
				renderer.requestRender();
			};
			if (key === "\x1b[C") step(2, 0);
			else if (key === "\x1b[D") step(-2, 0);
			else if (key === "\x1b[B") step(0, 1);
			else if (key === "\x1b[A") step(0, -1);
			else if (key === "q" || key === "\x03") resolve();
		});
	});

	process.stdout.write(deleteImageSequence(IMAGE_ID));
	await renderer.destroy();
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdout.write("\x1b[2J\x1b[Hdone\r\n");
}

// ---------------------------------------------------------------------------

const headlessRequested =
	process.argv.includes("--headless") || !process.stdout.isTTY;
if (headlessRequested) {
	const failures = await headless();
	process.exit(failures);
} else {
	await live();
}
