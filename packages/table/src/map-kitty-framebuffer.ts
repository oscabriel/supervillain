/**
 * The bitmap tier's raster buffer: a plain RGBA byte grid. Deliberately
 * terminal-blind — nothing here knows about APC sequences or cells — so the
 * same pixels feed any encoder the tier grows (the one-raster-many-encoders
 * lesson from the gloomberb reference).
 */
import type { Rgb } from "./map-kitty.js";

export class Framebuffer {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.pixels = new Uint8Array(width * height * 4);
	}

	setPixel(x: number, y: number, rgb: Rgb, alpha = 255): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
			return;
		}
		const offset = (y * this.width + x) * 4;
		const [red, green, blue] = rgb;
		this.pixels[offset] = red;
		this.pixels[offset + 1] = green;
		this.pixels[offset + 2] = blue;
		this.pixels[offset + 3] = alpha;
	}

	getPixel(x: number, y: number): Rgb {
		const [red = 0, green = 0, blue = 0] = this.rowAt(x, y);
		return [red, green, blue];
	}

	alphaAt(x: number, y: number): number {
		return this.rowAt(x, y)[3] ?? 0;
	}

	cut(rx: number, ry: number, rw: number, rh: number): Framebuffer {
		const out = new Framebuffer(rw, rh);
		for (let y = 0; y < rh; y += 1) {
			for (let x = 0; x < rw; x += 1) {
				const [red = 0, green = 0, blue = 0, alpha = 0] =
					this.rowAt(rx + x, ry + y);
				out.pixels.set([red, green, blue, alpha], (y * rw + x) * 4);
			}
		}
		return out;
	}

	private rowAt(x: number, y: number): Uint8Array {
		return this.pixels.subarray((y * this.width + x) * 4);
	}
}
