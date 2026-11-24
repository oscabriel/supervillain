import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./Model.ts";

const FONT = '400 12.5px "Geist Mono", ui-monospace, SFMono-Regular, monospace';

const CELL_H = 20;

const FLIP_MS = 48;

const AMBIENT_SPEED = 118;

const CLICK_SPEED = 148;

const AMBIENT_BAND = 42;

const CLICK_BAND = 34;

const REST_GAP_MS = 1200;

const SCRAMBLE_POOL =
	"!@#$%^&*()_+-=[]{}|;:',.<>?/~`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

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

export interface TextField {
	readonly cols: number;
	readonly rows: number;
	readonly cellW: number;
	readonly cellH: number;
	readonly chars: ReadonlyArray<string>;
}

export interface Ripple {
	readonly ox: number;
	readonly oy: number;
	readonly startedAt: number;
	readonly speed: number;
	readonly bandWidth: number;
	readonly maxRadius: number;
	readonly strength: number;
}

export const buildTextField = (
	cols: number,
	rows: number,
	cellW: number
): TextField => {
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

	return { cols, rows, cellW, cellH: CELL_H, chars };
};

export const farthestCorner = (
	ox: number,
	oy: number,
	width: number,
	height: number
): number =>
	Math.max(
		Math.hypot(ox, oy),
		Math.hypot(width - ox, oy),
		Math.hypot(ox, height - oy),
		Math.hypot(width - ox, height - oy)
	);

export const rippleRadiusAt = (ripple: Ripple, nowMs: number): number =>
	Math.max(0, ((nowMs - ripple.startedAt) / 1000) * ripple.speed);

export const isRippleFinished = (ripple: Ripple, nowMs: number): boolean =>
	rippleRadiusAt(ripple, nowMs) > ripple.maxRadius + ripple.bandWidth * 3.2;

export const rippleIntensityAt = (
	ripple: Ripple,
	px: number,
	py: number,
	nowMs: number
): number => {
	const elapsed = nowMs - ripple.startedAt;

	if (elapsed < 0) {
		return 0;
	}

	const radius = (elapsed / 1000) * ripple.speed;

	if (radius > ripple.maxRadius + ripple.bandWidth * 3.2) {
		return 0;
	}

	const dist = Math.hypot(px - ripple.ox, py - ripple.oy);
	const delta = dist - radius;
	const band = ripple.bandWidth;

	if (Math.abs(delta) > band * 3.2) {
		return 0;
	}

	const bell = Math.exp(-(delta * delta) / (2 * band * band));
	const fadeIn = Math.min(1, elapsed / 450);

	const tailStart = ripple.maxRadius - band;

	const fadeOut =
		radius <= tailStart
			? 1
			: Math.max(0, 1 - (radius - tailStart) / (band * 3.2));

	return bell * fadeIn * fadeOut * ripple.strength;
};

const hashCell = (x: number, y: number, tick: number): number => {
	const n = Math.imul(x + 17, 374_761_393) + Math.imul(y + 31, 668_265_263);

	const mixed = Math.imul(
		n + Math.imul(tick + 13, 2_147_483_647),
		1_274_126_177
	);

	return Math.abs(mixed);
};

export const scrambleChar = (
	base: string,
	intensity: number,
	x: number,
	y: number,
	flipTick: number
): string => {
	if (intensity < 0.14) {
		return base;
	}

	const hashed = hashCell(x, y, flipTick);
	const threshold = (hashed % 1000) / 1000;

	if (base === " " && intensity < 0.42) {
		return " ";
	}

	if (threshold > Math.min(0.96, intensity * 1.18)) {
		return base;
	}

	return SCRAMBLE_POOL[hashed % SCRAMBLE_POOL.length] ?? base;
};

interface PickedRipple {
	readonly ripple: Ripple;
	readonly zone: number;
}

const pickAmbientRipple = (
	width: number,
	height: number,
	nowMs: number,
	previousZone: number
): PickedRipple => {
	const candidate = Math.floor(Math.random() * 4);
	const zone = candidate === previousZone ? (candidate + 1) % 4 : candidate;
	const t = 0.12 + Math.random() * 0.76;

	let ox = 0;
	let oy = 0;

	if (zone === 0) {
		ox = width * 0.04;
		oy = height * t;
	} else if (zone === 1) {
		ox = width * 0.96;
		oy = height * t;
	} else if (zone === 2) {
		ox = width * t;
		oy = height * 0.06;
	} else {
		ox = width * t;
		oy = height * 0.94;
	}

	return {
		zone,
		ripple: {
			ox,
			oy,
			startedAt: nowMs,
			speed: AMBIENT_SPEED,
			bandWidth: AMBIENT_BAND,
			maxRadius: farthestCorner(ox, oy, width, height),
			strength: 1,
		},
	};
};

const fillStyleFor = (intensity: number): string => {
	if (intensity < 0.04) {
		return "rgba(161, 161, 174, 0.115)";
	}

	const alpha = Math.min(0.46, 0.115 + intensity * 0.34);

	if (intensity > 0.72) {
		return `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
	}

	if (intensity > 0.28) {
		return `rgba(232, 232, 240, ${alpha.toFixed(3)})`;
	}

	return `rgba(182, 182, 194, ${alpha.toFixed(3)})`;
};

const paintField = (
	ctx: CanvasRenderingContext2D,
	field: TextField,
	width: number,
	height: number,
	ripples: ReadonlyArray<Ripple>,
	nowMs: number
): void => {
	const { cols, rows, cellW, cellH, chars } = field;
	const flipTick = Math.floor(nowMs / FLIP_MS);

	ctx.clearRect(0, 0, width, height);
	ctx.font = FONT;
	ctx.textBaseline = "top";

	for (let y = 0; y < rows; y += 1) {
		const row = y * cols;
		const py = y * cellH + 4;
		const cy = py + cellH * 0.5;

		for (let x = 0; x < cols; x += 1) {
			const base = chars[row + x] ?? " ";
			const px = x * cellW;
			const cx = px + cellW * 0.5;
			let intensity = 0;

			for (const ripple of ripples) {
				const value = rippleIntensityAt(ripple, cx, cy, nowMs);

				if (value > intensity) {
					intensity = value;
				}
			}

			if (base === " " && intensity < 0.42) {
				continue;
			}

			const ch = scrambleChar(base, intensity, x, y, flipTick);

			ctx.fillStyle = fillStyleFor(intensity);
			ctx.fillText(ch, px, py);
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
	let field = buildTextField(1, 1, 8);
	let ambient: Ripple | undefined;
	let clickRipple: Ripple | undefined;
	let lastZone = -1;
	let nextAmbientAt = 0;
	let frameId = 0;
	let inView = true;
	let disposed = false;

	const activeRipples = (nowMs: number): Array<Ripple> => {
		const list: Array<Ripple> = [];

		if (ambient !== undefined) {
			if (isRippleFinished(ambient, nowMs)) {
				ambient = undefined;
				nextAmbientAt = nowMs + REST_GAP_MS;
			} else {
				list.push(ambient);
			}
		}

		if (clickRipple !== undefined) {
			if (isRippleFinished(clickRipple, nowMs)) {
				clickRipple = undefined;
			} else {
				list.push(clickRipple);
			}
		}

		return list;
	};

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
		const nowMs = performance.now();

		field = buildTextField(cols, rows, cellW);

		if (reduced) {
			const calm: Ripple = {
				ox: width * 0.08,
				oy: height * 0.24,
				startedAt: nowMs - 2600,
				speed: AMBIENT_SPEED,
				bandWidth: AMBIENT_BAND,
				maxRadius: farthestCorner(width * 0.08, height * 0.24, width, height),
				strength: 0.75,
			};

			paintField(ctx, field, width, height, [calm], nowMs);

			return;
		}

		if (ambient === undefined) {
			const picked = pickAmbientRipple(width, height, nowMs - 900, lastZone);

			ambient = picked.ripple;
			lastZone = picked.zone;
		}

		paintField(ctx, field, width, height, activeRipples(nowMs), nowMs);
	};

	const stopLoop = (): void => {
		if (frameId !== 0) {
			window.cancelAnimationFrame(frameId);
			frameId = 0;
		}
	};

	const tick = (nowMs: number): void => {
		frameId = 0;

		if (disposed || reduced || document.hidden || !inView) {
			return;
		}

		if (ambient === undefined && nowMs >= nextAmbientAt) {
			const picked = pickAmbientRipple(width, height, nowMs, lastZone);

			ambient = picked.ripple;
			lastZone = picked.zone;
		}

		paintField(ctx, field, width, height, activeRipples(nowMs), nowMs);
		frameId = window.requestAnimationFrame(tick);
	};

	const startLoop = (): void => {
		if (!disposed && !reduced && !document.hidden && inView && frameId === 0) {
			frameId = window.requestAnimationFrame(tick);
		}
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (reduced) {
			return;
		}

		const rect = surface.getBoundingClientRect();
		const ox = event.clientX - rect.left;
		const oy = event.clientY - rect.top;

		clickRipple = {
			ox,
			oy,
			startedAt: performance.now(),
			speed: CLICK_SPEED,
			bandWidth: CLICK_BAND,
			maxRadius: farthestCorner(ox, oy, width, height),
			strength: 1,
		};
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
