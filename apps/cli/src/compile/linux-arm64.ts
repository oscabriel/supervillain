/* oxlint-disable unicorn/prefer-module -- bun build --compile needs a static bare require of the per-triple .node addon (#11) */
import { provideIrohNative } from "@supervillain/transport-iroh";

const native = require("@number0/iroh-linux-arm64-gnu/iroh.linux-arm64-gnu.node");

provideIrohNative(native as never);
await import("../index.js");
