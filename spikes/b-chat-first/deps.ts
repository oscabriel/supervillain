// Throwaway spike: borrows the OpenTUI install the archived build already has.
const core = new URL(
	"../../packages/table/node_modules/@opentui/core/index.js",
	import.meta.url
);
const ssh = new URL(
	"../../apps/gateway/node_modules/@opentui/ssh/index.js",
	import.meta.url
);

type Core = typeof import("@opentui/core");

export const {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	RGBA,
	ScrollBoxRenderable,
	StyledText,
	TextAttributes,
	TextRenderable,
} = (await import(core.href)) as Core;

export const { createServer } = (await import(ssh.href)) as {
	createServer: typeof import("@opentui/ssh").createServer;
};

export type {
	CliRenderer,
	KeyEvent,
	MouseEvent,
	TextChunk,
} from "@opentui/core";
