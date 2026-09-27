// Throwaway spike: borrows the archived build's compiled packages read-only.
// Run `bun run build` at the repo root first.
import { createRequire } from "node:module";

export { decide } from "../../packages/games/draw-steel/dist/authority.js";
export {
	apply,
	eventTypes,
	init,
} from "../../packages/games/draw-steel/dist/model.js";
export { view } from "../../packages/games/draw-steel/dist/view.js";
export {
	InProcessRoomStore,
	RoomHost,
} from "../../packages/room-host/dist/index.js";
export { runTable } from "../../packages/table/dist/index.js";

const opentuiSshPath = new URL(
	"../../apps/gateway/node_modules/@opentui/ssh/index.js",
	import.meta.url
);
export const { createServer } = (await import(opentuiSshPath.href)) as {
	createServer: typeof import("@opentui/ssh").createServer;
};

// ssh2 is @opentui/ssh's own dependency; resolve it from there.
const requireFromSsh = createRequire(opentuiSshPath);
export const ssh2 = requireFromSsh("ssh2") as {
	Client: new () => import("node:events").EventEmitter & {
		connect: (config: Record<string, unknown>) => void;
		shell: (
			pty: { cols: number; rows: number; term: string },
			callback: (error: Error | undefined, stream: Ssh2Stream) => void
		) => void;
		end: () => void;
	};
	utils: {
		generateKeyPairSync: (type: "ed25519") => {
			private: string;
			public: string;
		};
	};
};

export interface Ssh2Stream extends NodeJS.ReadWriteStream {
	setWindow: (
		rows: number,
		cols: number,
		height: number,
		width: number
	) => void;
	close: () => void;
}
