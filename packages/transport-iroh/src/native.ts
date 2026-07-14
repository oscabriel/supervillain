import { createRequire } from "node:module";

import type * as Iroh from "@number0/iroh";

const workspaceRequire = createRequire(import.meta.url);
const require = createRequire(workspaceRequire.resolve("@number0/iroh/package.json"));

type IrohNative = typeof Iroh;

/**
 * Loads the native addon directly instead of using napi-rs's runtime platform loader.
 * Ticket #11 will finalize per-triple static entry selection for `bun build --compile`.
 */
export function loadIrohNative(): IrohNative {
  if (process.platform === "linux" && process.arch === "x64") {
    return require("@number0/iroh-linux-x64-gnu/iroh.linux-x64-gnu.node") as IrohNative;
  }

  if (process.platform === "linux" && process.arch === "arm64") {
    return require("@number0/iroh-linux-arm64-gnu/iroh.linux-arm64-gnu.node") as IrohNative;
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return require("@number0/iroh-darwin-arm64/iroh.darwin-arm64.node") as IrohNative;
  }

  throw new Error(
    `Unsupported iroh platform ${process.platform}-${process.arch}; ADR-0001 supports linux-x64, linux-arm64, and macos-arm64`,
  );
}
