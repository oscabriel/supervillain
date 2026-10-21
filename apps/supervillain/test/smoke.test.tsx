import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

test("renders a box headlessly", async () => {
  const t = await testRender(() => <text>hello table</text>, { width: 30, height: 3 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("hello table");
  t.renderer.destroy();
});
