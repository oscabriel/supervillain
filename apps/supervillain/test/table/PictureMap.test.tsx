import { afterEach, expect, test } from "bun:test";

import type { CliRenderer } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { useCellPixels } from "../../src/table/PictureMap.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;

let setup: Setup | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

const answer = async (renderer: CliRenderer, width: number, height: number) => {
	Object.assign(renderer, {
		waitingForPixelResolution: true,
		pixelResolutionRequeryPending: false,
		unansweredPixelQueries: 1,
	});
	renderer.stdin.emit("data", Buffer.from(`\u001B[4;${height};${width}t`));
	await Bun.sleep(0);
};

let cell: ReturnType<typeof useCellPixels> = () => {};

test("a seat's cell size comes from its terminal's answer and is kept through a resize", async () => {
	setup = await testRender(
		() => {
			cell = useCellPixels();

			return <text>cells</text>;
		},
		{ width: 128, height: 40 }
	);
	expect(cell()).toBeUndefined();

	await answer(setup.renderer, 2560, 1600);
	expect(cell()).toEqual({ width: 20, height: 40 });

	setup.renderer.resize(100, 40);
	expect(setup.renderer.resolution).toBeNull();
	expect(cell()).toEqual({ width: 20, height: 40 });

	await answer(setup.renderer, 1000, 800);
	expect(cell()).toEqual({ width: 10, height: 20 });
});
