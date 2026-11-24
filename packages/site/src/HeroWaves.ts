import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./Model.ts";

const FONT = '400 12.5px "Geist Mono", ui-monospace, SFMono-Regular, monospace';

const CELL_H = 20;

const DAMPING = 0.946;

const MAX_AMPLITUDE = 2.4;

const RIPPLE_GLYPHS = "·.,:;-~=+*";

const FANTASY_LINES: ReadonlyArray<string> = [
	"Torchlight gutters against damp limestone as the iron portcullis settles into the sill.",
	"A cold draft rises from the lower stair, carrying tallow smoke, wet moss, and the metallic tang of standing water.",
	"Three passages open off the cistern landing: salt-eaten oak, a collapsed arch choked with pale roots, and a narrow vault breathing in measured intervals.",
	"Your lantern holds half an hour of oil. Who takes the front of the marching order, and who keeps watch on the dark behind?",
	"Along the eastern gallery, fresh bootprints stop beside a sunken flagstone carved with a serpent swallowing a crown.",
	"Gravel shifts across the ford road before two hunched silhouettes detach themselves from the bridge pilings.",
	"The flagstones incline downward beneath your boots; dust drifts from the vaulted ceiling as something heavy turns below.",
	"Above the black cistern, a rusted winch still holds a length of frayed hemp rope disappearing into still water.",
	"Runes along the lintel warm beneath your palm, faint as embers in dead ash. Cross the threshold, or test the masonry first?",
	"Every footstep echoes twice in the barrel vault, and the second echo arrives half a beat too late.",
	"Beyond the shattered altar lies an open ledger, its ink still dark, naming the four heroes who descended before you.",
	"Distant watchfires blink along the ridge road as mist gathers in the hollows between the standing stones.",
];

const CORPUS = `${FANTASY_LINES.join("     ")}     `;

export interface WaveState {
	readonly cols: number;
	readonly rows: number;
	readonly cellW: number;
	readonly cellH: number;
	readonly chars: ReadonlyArray<string>;
	readonly current: Float32Array;
	readonly previous: Float32Array;
}

export const buildTextField = (
	cols: number,
	rows: number
): ReadonlyArray<string> => {
	const total = cols * rows;
	const chars: Array<string> = Array.from({ length: total });
	const len = CORPUS.length;

	for (let row = 0; row < rows; row += 1) {
		const offset = (row * 43) % len;
		const rowStart = row * cols;

		for (let col = 0; col < cols; col += 1) {
			chars[rowStart + col] = CORPUS[(offset + col) % len] ?? " ";
		}
	}

	return chars;
};

export const createWaveState = (
	cols: number,
	rows: number,
	cellW: number
): WaveState => {
	const total = cols * rows;

	return {
		cols,
		rows,
		cellW,
		cellH: CELL_H,
		chars: buildTextField(cols, rows),
		current: new Float32Array(total),
		previous: new Float32Array(total),
	};
};

export const dropRipple = (
	state: WaveState,
	cx: number,
	cy: number,
	strength: number,
	radius: number
): void => {
	const { cols, rows, current } = state;

	for (let dy = -radius; dy <= radius; dy += 1) {
		const y = cy + dy;

		if (y <= 1 || y >= rows - 2) {
			continue;
		}

		for (let dx = -radius; dx <= radius; dx += 1) {
			const x = cx + dx;

			if (x <= 1 || x >= cols - 2) {
				continue;
			}

			const dist = Math.hypot(dx, dy);

			if (dist <= radius) {
				const falloff = Math.cos((dist / radius) * (Math.PI / 2));
				const index = y * cols + x;
				const next = (current[index] ?? 0) + strength * falloff;

				current[index] = Math.max(
					-MAX_AMPLITUDE,
					Math.min(MAX_AMPLITUDE, next)
				);
			}
		}
	}
};

export const stepRipple = (state: WaveState): WaveState => {
	const { cols, rows, current, previous } = state;

	for (let y = 1; y < rows - 1; y += 1) {
		const row = y * cols;

		for (let x = 1; x < cols - 1; x += 1) {
			const i = row + x;

			const avg =
				((current[i - 1] ?? 0) +
					(current[i + 1] ?? 0) +
					(current[i - cols] ?? 0) +
					(current[i + cols] ?? 0)) *
				0.5;

			const raw = (avg - (previous[i] ?? 0)) * DAMPING;
			const clamped = Math.max(-MAX_AMPLITUDE, Math.min(MAX_AMPLITUDE, raw));

			previous[i] = Math.abs(clamped) < 0.002 ? 0 : clamped;
		}
	}

	return {
		...state,
		current: previous,
		previous: current,
	};
};

export const ambientWave = (x: number, y: number, timeSec: number): number => {
	const swell = Math.sin(x * 0.085 - timeSec * 0.72 + y * 0.16) * 0.24;
	const cross = Math.cos(x * 0.045 + y * 0.21 - timeSec * 0.48) * 0.16;

	return swell + cross;
};

export const glyphForEnergy = (
	base: string,
	energy: number,
	x: number,
	y: number
): string => {
	if (energy <= 0.34) {
		return base;
	}

	const index = Math.min(
		RIPPLE_GLYPHS.length - 1,
		Math.floor(energy * RIPPLE_GLYPHS.length)
	);

	if ((x + y) % 3 === 0 || base === " ") {
		return RIPPLE_GLYPHS[index] ?? base;
	}

	return base;
};

const clampIndex = (value: number, max: number): number =>
	Math.max(0, Math.min(max, Math.round(value)));

const fillStyleFor = (
	rippleVal: number,
	waveVal: number,
	energy: number
): string => {
	const crest = rippleVal + waveVal * 0.55;
	const alpha = Math.min(0.42, 0.095 + energy * 0.28);

	if (rippleVal > 0.38) {
		return `rgba(229, 192, 123, ${Math.min(0.46, alpha + 0.06).toFixed(3)})`;
	}

	if (crest > 0.14) {
		return `rgba(228, 228, 236, ${alpha.toFixed(3)})`;
	}

	if (crest < -0.14) {
		return `rgba(113, 113, 128, ${Math.max(0.06, alpha * 0.65).toFixed(3)})`;
	}

	return `rgba(161, 161, 174, ${alpha.toFixed(3)})`;
};

const paintWaves = (
	ctx: CanvasRenderingContext2D,
	state: WaveState,
	width: number,
	height: number,
	timeSec: number
): void => {
	const { cols, rows, cellW, cellH, chars, current } = state;

	ctx.clearRect(0, 0, width, height);
	ctx.font = FONT;
	ctx.textBaseline = "top";

	for (let y = 0; y < rows; y += 1) {
		const row = y * cols;
		const py = y * cellH + 4;

		for (let x = 0; x < cols; x += 1) {
			const i = row + x;
			const rVal = current[i] ?? 0;
			const wVal = ambientWave(x, y, timeSec);
			const val = rVal + wVal;

			const left = x > 0 ? (current[i - 1] ?? 0) : rVal;
			const right = x < cols - 1 ? (current[i + 1] ?? 0) : rVal;
			const up = y > 0 ? (current[i - cols] ?? 0) : rVal;
			const down = y < rows - 1 ? (current[i + cols] ?? 0) : rVal;

			const gx = right - left + (ambientWave(x + 1, y, timeSec) - wVal) * 0.9;
			const gy = down - up + (ambientWave(x, y + 1, timeSec) - wVal) * 0.9;

			const energy = Math.min(
				1,
				Math.abs(val) * 0.58 + Math.hypot(gx, gy) * 0.34
			);

			const sx = clampIndex(x + gx * 0.95, cols - 1);
			const sy = clampIndex(y + gy * 0.6, rows - 1);
			const base = chars[sy * cols + sx] ?? " ";

			if (base === " " && energy < 0.22) {
				continue;
			}

			const ch = glyphForEnergy(base, energy, x, y);

			ctx.fillStyle = fillStyleFor(rVal, wVal, energy);
			ctx.fillText(ch, x * cellW + gx * 1.6, py + gy * 1.15);
		}
	}
};

const prefersReducedMotion = (): boolean =>
	globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const mountHeroWaves = (element: Element): (() => void) | undefined => {
	if (!(element instanceof HTMLCanvasElement)) {
		return undefined;
	}

	const surface = element.parentElement;
	const ctx = element.getContext("2d");

	if (surface === null || ctx === null) {
		return undefined;
	}

	const reduced = prefersReducedMotion();
	let width = 0;
	let height = 0;
	let state = createWaveState(1, 1, 8);
	let frameId = 0;
	let inView = true;
	let lastPointerDrop = 0;
	let nextAmbientAt = performance.now() + 2600;
	let disposed = false;

	const rebuild = (): void => {
		const rect = surface.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);

		width = Math.max(1, rect.width);
		height = Math.max(1, rect.height);
		element.width = Math.max(1, Math.floor(width * dpr));
		element.height = Math.max(1, Math.floor(height * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = FONT;

		const cellW = Math.max(7.4, ctx.measureText("M").width + 0.5);
		const cols = Math.ceil(width / cellW) + 1;
		const rows = Math.ceil(height / CELL_H) + 1;

		state = createWaveState(cols, rows, cellW);
		dropRipple(
			state,
			Math.floor(cols * 0.22),
			Math.floor(rows * 0.34),
			1.05,
			4
		);
		dropRipple(
			state,
			Math.floor(cols * 0.78),
			Math.floor(rows * 0.64),
			1.15,
			5
		);

		for (let i = 0; i < 6; i += 1) {
			state = stepRipple(state);
		}

		paintWaves(ctx, state, width, height, performance.now() / 1000);
	};

	const stopLoop = (): void => {
		if (frameId !== 0) {
			window.cancelAnimationFrame(frameId);
			frameId = 0;
		}
	};

	const tick = (now: number): void => {
		frameId = 0;

		if (disposed || reduced || document.hidden || !inView) {
			return;
		}

		if (now >= nextAmbientAt) {
			nextAmbientAt = now + 3000 + Math.random() * 1600;

			const rx = Math.floor(state.cols * (0.12 + Math.random() * 0.76));
			const ry = Math.floor(state.rows * (0.16 + Math.random() * 0.68));

			dropRipple(state, rx, ry, 1.15, 4);
		}

		state = stepRipple(state);
		paintWaves(ctx, state, width, height, now / 1000);
		frameId = window.requestAnimationFrame(tick);
	};

	const startLoop = (): void => {
		if (!disposed && !reduced && !document.hidden && inView && frameId === 0) {
			frameId = window.requestAnimationFrame(tick);
		}
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (reduced) {
			return;
		}

		const now = performance.now();

		if (now - lastPointerDrop < 32) {
			return;
		}

		lastPointerDrop = now;

		const rect = surface.getBoundingClientRect();
		const cx = Math.floor((event.clientX - rect.left) / state.cellW);
		const cy = Math.floor((event.clientY - rect.top) / state.cellH);

		dropRipple(state, cx, cy, 0.85, 3);
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (reduced) {
			return;
		}

		const rect = surface.getBoundingClientRect();
		const cx = Math.floor((event.clientX - rect.left) / state.cellW);
		const cy = Math.floor((event.clientY - rect.top) / state.cellH);

		dropRipple(state, cx, cy, 1.65, 5);
	};

	const onVisibilityChange = (): void => {
		if (document.hidden) {
			stopLoop();
		} else {
			startLoop();
		}
	};

	const resizeObserver = new ResizeObserver(() => {
		rebuild();
	});

	const intersectionObserver = new IntersectionObserver((entries) => {
		inView = entries.some((entry) => entry.isIntersecting);

		if (inView) {
			startLoop();
		} else {
			stopLoop();
		}
	});

	rebuild();
	resizeObserver.observe(surface);
	intersectionObserver.observe(surface);
	surface.addEventListener("pointermove", onPointerMove, { passive: true });
	surface.addEventListener("pointerdown", onPointerDown, { passive: true });
	document.addEventListener("visibilitychange", onVisibilityChange);

	const syncFonts = async (): Promise<void> => {
		await document.fonts.ready;

		if (!disposed) {
			rebuild();
		}
	};

	void syncFonts();

	startLoop();

	return () => {
		disposed = true;
		stopLoop();
		resizeObserver.disconnect();
		intersectionObserver.disconnect();
		surface.removeEventListener("pointermove", onPointerMove);
		surface.removeEventListener("pointerdown", onPointerDown);
		document.removeEventListener("visibilitychange", onVisibilityChange);
	};
};

export const HeroWaves = Mount.define("HeroWaves", {
	messages: [Message.MountedHeroWaves],
	execute: ({ element }) =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.sync(() => mountHeroWaves(element)),
				(cleanup) =>
					Effect.sync(() => {
						cleanup?.();
					})
			);

			return Message.MountedHeroWaves();
		}),
});
