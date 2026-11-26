import type { FileSystem, Path } from "effect";

import type { TableServices } from "../host/services.ts";

export type McpRole = "gm" | "player";

export interface McpSeat {
	readonly actor: string;
	readonly role: McpRole;
	readonly rateKey: string;
	readonly room: string;
}

export type McpServices = TableServices | FileSystem.FileSystem | Path.Path;

export const AGENT_NEEDS_KEY =
	"Agents need an SSH key so your identity stays consistent across reconnects.";

export const AGENT_SERVER = "supervillain";
