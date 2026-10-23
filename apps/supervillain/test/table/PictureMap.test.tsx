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

/**
 * The terminal answers the renderer's window-size question. The test renderer never asks, so this
 * marks the question asked (privates of OpenTUI 0.6.6's renderer) and lets its own handler read it.
 */
const answer = async (renderer: CliRenderer, width: number, height: number) => {
  Object.assign(renderer, {
    waitingForPixelResolution: true,
    pixelResolutionRequeryPending: false,
  });
  renderer.stdin.emit("data", Buffer.from(`\x1b[4;${height};${width}t`));
  await Bun.sleep(0);
};

test("a seat's cell size comes from its terminal's answer and is kept through a resize", async () => {
  let cell: ReturnType<typeof useCellPixels> = () => undefined;
  setup = await testRender(
    () => {
      cell = useCellPixels();
      return <text>cells</text>;
    },
    { width: 128, height: 40 },
  );
  expect(cell()).toBeUndefined();

  await answer(setup.renderer, 2560, 1600);
  expect(cell()).toEqual({ width: 20, height: 40 });

  // A resize forgets the window's size until the terminal answers again; the cells stay known.
  setup.renderer.resize(100, 40);
  expect(setup.renderer.resolution).toBeNull();
  expect(cell()).toEqual({ width: 20, height: 40 });

  // A smaller font: more cells in the same window.
  await answer(setup.renderer, 1000, 800);
  expect(cell()).toEqual({ width: 10, height: 20 });
});
