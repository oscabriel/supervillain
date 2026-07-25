import { createRequire } from "node:module";

import type * as Iroh from "@number0/iroh";

export type IrohNative = typeof Iroh;

let providedNative: IrohNative | undefined;

export const provideIrohNative = (native: IrohNative): void => {
	providedNative = native;
};

/** Loads the provided addon or the native addon for the current platform. */
export const loadIrohNative = (): IrohNative => {
	if (providedNative !== undefined) {
		return providedNative;
	}

	const workspaceRequire = createRequire(import.meta.url);
	const require = createRequire(
		workspaceRequire.resolve("@number0/iroh/package.json")
	);

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
		`Unsupported iroh platform ${process.platform}-${process.arch}; iroh builds exist for linux-x64, linux-arm64, and macos-arm64 only`
	);
};
