import type { Socket } from "node:net";
import type { Duplex, Writable } from "node:stream";

import type { CliRenderer } from "@opentui/core";
import type { Effect, Scope } from "effect";
import { Schema } from "effect";

export type Identity =
	| {
			readonly kind: "key";
			readonly actor: `key:${string}`;
			readonly fingerprint: string;
			readonly algorithm: string;
	  }
	| { readonly kind: "guest"; readonly actor: `guest:${string}` };

export interface SessionInfo {
	readonly identity: Identity;
	readonly user: string;
	readonly term: string;
	readonly cols: number;
	readonly rows: number;
	readonly env: Readonly<Record<string, string>>;
	readonly remoteAddress: string;
	readonly client: string;
	readonly relayedActor?: string;
	readonly relayedInvite?: string;
	readonly relayedBucket?: string;
}

export interface ShellSession {
	readonly info: SessionInfo;
	readonly renderer: CliRenderer;
	readonly close: () => void;
}

export interface ExecSession {
	readonly info: SessionInfo;
	readonly command: string;
	readonly write: (text: string) => void;
	readonly writeError: (text: string) => void;
}

export type RawRequest =
	| { readonly kind: "shell" }
	| { readonly kind: "exec"; readonly command: string }
	| { readonly kind: "subsystem"; readonly name: string };

export type RawExit =
	| number
	| {
			readonly signal: string;
			readonly coreDumped?: boolean;
			readonly message?: string;
	  };

export interface RawSession {
	readonly info: SessionInfo;
	readonly request: RawRequest;
	readonly pty: boolean;
	readonly stream: Duplex;
	readonly stderr: Writable;
	readonly onResize: (listener: (cols: number, rows: number) => void) => void;
	readonly exit: (how: RawExit) => void;
	readonly asShell?: (
		onShell: (session: ShellSession) => Effect.Effect<void, never, Scope.Scope>
	) => Effect.Effect<void, never, Scope.Scope>;
}

export interface Limits {
	readonly connections?: number;
	readonly connectionsPerAddress?: number;
	readonly sessionsPerConnection?: number;
	readonly sessionsPerRelay?: number;
	readonly sessionsPerAddress?: number;
	readonly sessions?: number;
	readonly connectRate?: { readonly burst: number; readonly perSecond: number };
	readonly sessionRate?: { readonly burst: number; readonly perSecond: number };
}

export interface Timeouts {
	readonly loginMs?: number;
	readonly sessionStartMs?: number;
	readonly keepaliveMs?: number;
	readonly keepaliveCount?: number;
}

export interface ServeOptions {
	readonly hostKeyPath: string;
	readonly port: number;
	readonly host: string;
	readonly allowGuests?: boolean;
	readonly trustedRelayKeys?: ReadonlyArray<string>;
	readonly limits?: Limits;
	readonly timeouts?: Timeouts;
	readonly noPtyMessage?: string;
	readonly shutdownNotice?: string;
	readonly onShell?: (
		session: ShellSession
	) => Effect.Effect<void, never, Scope.Scope>;
	readonly onExec?: (
		session: ExecSession
	) => Effect.Effect<number, never, Scope.Scope>;
	readonly onRaw?: (
		session: RawSession
	) => Effect.Effect<void, never, Scope.Scope>;
	readonly relaySubsystems?: Readonly<
		Record<
			string,
			(session: RawSession) => Effect.Effect<void, never, Scope.Scope>
		>
	>;
	readonly subsystems?: Readonly<
		Record<
			string,
			(session: RawSession) => Effect.Effect<void, never, Scope.Scope>
		>
	>;
}

export interface AttachOptions {
	readonly hostKey?: Buffer;
	readonly trustedRelayKeys?: ReadonlyArray<string>;
	readonly admitRelay?: (fingerprint: string) => boolean;
	readonly persistent?: boolean;
}

export interface SshServer {
	readonly port: number;
	readonly hostKeyFingerprint: string;
	readonly attach: (socket: Socket, options?: AttachOptions) => void;
}

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}
