#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createServer, DenyError } from "@opentui/ssh";
import type { Session as SshSession } from "@opentui/ssh";
import type { GatewayRegistry } from "@supervillain/core";
import {
	apply as drawSteelApply,
	init as drawSteelInit,
} from "@supervillain/draw-steel/model";
import { view as drawSteelView } from "@supervillain/draw-steel/view";
import { apply as fakeApply, init as fakeInit } from "@supervillain/fake/model";
import { view as fakeView } from "@supervillain/fake/view";
import { loadOrCreateIdentity } from "@supervillain/identity";
import { serveHostPipes } from "@supervillain/room-wire";
import type {
	GatewayPipeEvent,
	HostPipeServer,
	LiveRoom,
	RoomView,
	RoomViewReservation,
} from "@supervillain/room-wire";
import type { TerminalConnection } from "@supervillain/session";
import { createTableCheckpointProducer, runTable } from "@supervillain/table";
import type {
	TableHold,
	TablePreferenceChange,
	TableViewOptions,
} from "@supervillain/table";
import { runLobby } from "@supervillain/table/lobby";
import type { LobbyNotice, LobbyOutcome } from "@supervillain/table/lobby";
import { startWsListener } from "@supervillain/transport-ws/server";

import {
	capacityFromEnvironment,
	clampPtySize,
	DEFAULT_CAPACITY_LIMITS,
	isOversizedPty,
	oversizedTerminalNotice,
} from "./capacity.js";
import type { CapacityLimits, GatewayCapacity } from "./capacity.js";
import { actorFromIdentity, admitsPublicKey } from "./door-auth.js";
import { guestIdentity, guestUpgradeBox, keyedIdentity } from "./guest.js";
import type { SessionIdentity } from "./guest.js";
import {
	createConnectionRateLimiter,
	createLobbyDeadlines,
	DEFAULT_LOBBY_LIMITS,
	LOBBY_EXPIRY_MESSAGE,
} from "./hardening.js";
import type { LobbyDeadlines, LobbyExpiry, LobbyLimits } from "./hardening.js";
import { startIdentityConduit } from "./identity-conduit.js";
import { createOfflineMetrics } from "./offline-metrics.js";
import type { OfflineCounts, OfflineMetrics } from "./offline-metrics.js";
import { openRoomRegistry } from "./registry.js";
import type {
	GatewayRoomRegistry,
	PresentationPreferences,
} from "./registry.js";
import {
	createKeyedSessions,
	doorRefusal,
	keyedActorOf,
	REVOKED_SESSION_MESSAGE,
} from "./revocation.js";
import type { KeyedSessions } from "./revocation.js";
import { GATEWAY_ROLE_USAGE, parseGatewayRoleArgs } from "./role.js";
import { holdRoom } from "./room-hold.js";
import type { RoomHoldEnd } from "./room-hold.js";
import {
	attachDoorConnection,
	holdDoorInput,
	sessionForActor,
} from "./ssh-session.js";
import type { DoorInputHold } from "./ssh-session.js";
import { pipePairingCode, resolveGatewayTls } from "./tls.js";
import type { GatewayTlsOptions } from "./tls.js";

type SshRenderer = SshSession["renderer"];

export {
	loadOrMintPipeCertificate,
	pipePairingCode,
	resolveGatewayTls,
} from "./tls.js";
export type {
	GatewayTlsMode,
	GatewayTlsOptions,
	ResolvedGatewayTls,
} from "./tls.js";

export {
	CAPACITY_ENVIRONMENT,
	capacityFromEnvironment,
	clampPtySize,
	DEFAULT_CAPACITY_LIMITS,
	DEFAULT_GATEWAY_CAPACITY,
	isOversizedPty,
	oversizedTerminalNotice,
	PTY_LIBRARY_CEILING,
} from "./capacity.js";
export type { CapacityLimits, GatewayCapacity, PtySize } from "./capacity.js";

export {
	GATEWAY_ROLE_USAGE,
	parseGatewayRoleArgs,
	type GatewayRoleEnvironment,
	type GatewayRoleOptions,
	type GatewayRoleParse,
} from "./role.js";
export {
	OPERATED_GATEWAY_STATE_DIR,
	resolveGatewayStateDir,
} from "./state-dir.js";
export {
	createKeyedSessions,
	doorRefusal,
	keyedActorOf,
	REVOKED_DOOR_MESSAGE,
	REVOKED_SESSION_MESSAGE,
} from "./revocation.js";
export type { KeyedSessions } from "./revocation.js";

/** The one port a self-hosted operator forwards. A tunable default, not a
 * protocol constant: 443 belongs to Caddy on the hosted box (#40), so the pipe
 * takes the conventional alternate. */
const DEFAULT_PIPE_PORT = 8443;
/** The hosted web's same-box cold-path hop; never bound beyond loopback. */
const DEFAULT_IDENTITY_CONDUIT_PORT = 3002;

const gatewayRegistry: GatewayRegistry = {
	get: (gameId) => {
		if (gameId === "fake") {
			return {
				model: { apply: fakeApply, init: fakeInit },
				view: fakeView,
			} as never;
		}
		return gameId === "draw-steel"
			? ({
					model: { apply: drawSteelApply, init: drawSteelInit },
					view: drawSteelView,
				} as never)
			: undefined;
	},
};

/** What the gateway's exhaust may say (ADR-0012, NQ-11): pipe lifecycle from
 * `room-wire`, plus the door's error *codes* — an error's name is metadata, its
 * message may carry anything, so only the code leaves the process. */
export type GatewayEvent =
	| GatewayPipeEvent
	| { readonly kind: "door-error"; readonly code: string };

export interface GatewayOptions {
	/** Holds the gateway identity, SSH host key, and registry database. */
	readonly stateDir: string;
	readonly sshPort: number;
	/** Hostname players are told to ssh to — the summon line, not the bind. */
	readonly sshHost: string;
	readonly bindHost?: string;
	/** TCP port for the room-wire pipe. Defaults to 8443 when this process is the
	 * TLS edge — the one port a self-hosted operator forwards — and to an
	 * ephemeral port when TLS is terminated upstream. */
	readonly brokerPort?: number;
	/** The pipe URL Hosts should dial, when it differs from the bind. */
	readonly brokerUrl?: string;
	/** Loopback-only identity conduit port. Embedded/test gateways default to an
	 * ephemeral port; the operated gateway role pins 3002. */
	readonly identityConduitPort?: number;
	/** Where the pipe's TLS ends (ADR-0014). Default: `self-signed`, so a gateway
	 * started with no arguments never carries production traffic in the clear. */
	readonly tls?: GatewayTlsOptions;
	/** Connection-lifecycle exhaust. Metadata only (ADR-0012, NQ-11). */
	readonly onEvent?: (event: GatewayEvent) => void;
	/** Lobby hardening: idle/max timeouts and the per-IP connection window. The
	 * lobby is an unauthenticated held session, so these are on from day one
	 * (ADR-0008). Defaults are floors against squatting, not capacity policy. */
	readonly lobbyLimits?: LobbyLimits;
	/** The protective caps of ADR-0012 (NQ-10) and the PTY cap (NQ-14): rooms
	 * per identity, sessions per Room, the per-session envelope-lag budget, and the
	 * rendered terminal ceiling. Ops-tunable — `serveGateway` reads them from
	 * the environment. Defaults are the R9 benchmark's chosen numbers. */
	readonly capacity?: CapacityLimits;
	/** How long a seated player is held when their Host goes offline. */
	readonly graceWindowMs?: number;
	readonly gracePollMs?: number;
}

export interface RunningGateway {
	/** The gateway's transport URL — what `create --gateway` dials. */
	readonly url: string;
	/** The Door's bound port, including the OS-assigned port after binding zero. */
	readonly sshPort: number;
	/** The offline tripwire's running counts (ADR-0012, NQ-15). */
	readonly offline: () => OfflineCounts;
	/** The Host-onboarding pairing code: this gateway's URL, carrying its
	 * certificate fingerprint when trust comes from a pin rather than a CA.
	 * Undefined when the address Hosts reach this box at is not knowable here. */
	readonly pairingCode: string | undefined;
	/** The fingerprint a Host pins, for a gateway with no CA behind it. */
	readonly certificateFingerprint: string | undefined;
	/** ADR-0013's local-only hosted-web identity hop. */
	readonly identityConduitUrl: string;
	readonly close: () => Promise<void>;
}

/** The raw-byte face of one library session that the rounds write plain text
 * through, plus the keystroke stream a between-screens pause waits on.
 * Structural on purpose: tests drive the rounds with plain fakes. */
interface DoorIo {
	readonly write: (data: Buffer | string) => void;
	readonly input: NodeJS.ReadStream;
	readonly onClose: (listener: () => void) => () => void;
}

interface ShellGateSession {
	readonly hasPty: boolean;
	readonly write: (data: Buffer | string) => void;
	readonly end: () => void;
}

const NO_PTY_NOTICE =
	"this door is interactive; run ssh -t, or use the CLI for scripts";

/** Keeps a PTY-less shell on the main screen, then uses the library's denial
 * signal only to unwind before the renderer-backed Lobby handler. */
export const requireInteractiveShell = <Handoff>(
	session: ShellGateSession,
	next: () => Handoff
): Handoff => {
	if (!session.hasPty) {
		session.write(`${NO_PTY_NOTICE}\r\n`);
		session.end();
		throw new DenyError();
	}
	return next();
};

/** Resolves the session's identity state from what the library verified. A key
 * resolves to an actor at connect — the key *is* the identity, nothing is
 * minted (`@opentui/ssh` runs the admission policy only after the signature
 * over the session blob checks out). A keyless visitor resolves to the
 * pre-identity guest state: ADR-0008 mints the `guest:` actor lazily, at first
 * room entry, because the lobby writes to no log. */
const identityOf = (identity: {
	readonly method: string;
	readonly username: string;
	readonly publicKey?: { readonly blob: Buffer };
}): SessionIdentity => {
	const actor = actorFromIdentity(identity);
	return actor === undefined ? guestIdentity() : keyedIdentity(actor);
};

/** The one fact about a door error that may leave the process (NQ-11): its
 * `code` when it carries one, its name otherwise — never the message, which
 * can quote anything the peer sent. */
const errorCodeOf = (error: unknown): string => {
	if (error instanceof Error) {
		const { code } = error as { readonly code?: unknown };
		return typeof code === "string" ? code : error.name;
	}
	return "unknown";
};

/** Clear and home — the canvas a plain-text interlude between two screens
 * needs, now that one renderer's alt-screen spans the whole session. */
const CLEAR_SCREEN = "\u001B[2J\u001B[H";

/** Waits for one keystroke, or for the client to leave first. Both paths
 * detach everything they added — a session that ends here leaves nothing
 * subscribed to the channel. */
const awaitKeypress = (door: DoorIo): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a single keypress is an event, not a promise-returning API.
	new Promise((resolve) => {
		let settled = false;
		const detach: (() => void)[] = [];
		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			for (const off of detach) {
				off();
			}
			resolve();
		};
		door.input.on("data", finish);
		door.input.resume();
		detach.push(() => door.input.off("data", finish), door.onClose(finish));
	});

export interface SessionPresentationPreferences {
	feedRail?: boolean;
	focusMarker?: boolean;
	sidebarRail?: boolean;
}

interface RoomEntryContext {
	/** The durable half — it answers whether a name is claimed at all. */
	readonly registry: GatewayRoomRegistry;
	/** The live half — which Host pipe currently carries a name (ADR-0012). */
	readonly pipes: HostPipeServer;
	readonly identity: SessionIdentity;
	/** Guest-only preferences, retained across room hops in this Door session. */
	readonly sessionPreferences: SessionPresentationPreferences;
	/** The one renderer this session draws on, minted and destroyed by
	 * `serveShell` and borrowed by every lobby and table round (ADR-0016). */
	readonly renderer: SshRenderer;
	/** The offline tripwire's counters (NQ-15). Counts only. */
	readonly metrics: OfflineMetrics;
	/** The protective caps this door enforces (NQ-10). */
	readonly limits: CapacityLimits;
	/** How long a seat is held when its Host goes offline. */
	readonly graceMs?: number;
	readonly gracePollMs?: number;
}

/** How one attempt at sitting down ended. `notice` is the lobby's business —
 * an unregistered or unreachable name is never a disconnect (ADR-0008).
 * `failed` is the floor: a plain-text one-liner, then the door closes. */
type RoomEntryResult =
	| { readonly kind: "entered" }
	| { readonly kind: "notice"; readonly notice: LobbyNotice }
	| { readonly kind: "failed"; readonly message: string };

export interface TablePreferenceAdapter {
	readonly onPreferenceChange: (change: TablePreferenceChange) => void;
	readonly viewOptions: TableViewOptions;
}

/** Resolves the Door session's presentation seam. Keyed sessions read and
 * write by resolved identity; Guests share only the mutable session object. */
export const tablePreferenceAdapter = (options: {
	readonly actor: string;
	readonly keyed: boolean;
	readonly registry: Pick<
		GatewayRoomRegistry,
		"presentationPreferences" | "resolveIdentity" | "setPresentationPreference"
	>;
	readonly sessionPreferences: SessionPresentationPreferences;
}): TablePreferenceAdapter => {
	let identityId: string | undefined;
	let preferences: PresentationPreferences;
	if (options.keyed) {
		identityId = options.registry.resolveIdentity(options.actor);
		preferences = options.registry.presentationPreferences(identityId);
	} else {
		preferences = options.sessionPreferences;
	}
	return {
		onPreferenceChange: (change) => {
			if (identityId !== undefined) {
				options.registry.setPresentationPreference(
					identityId,
					change.preference,
					change.value
				);
				return;
			}
			options.sessionPreferences[change.preference] = change.value;
		},
		viewOptions: { ...preferences },
	};
};

const runRoomTable = async (
	connection: TerminalConnection,
	door: DoorIo,
	store: RoomView,
	context: RoomEntryContext,
	hold: TableHold,
	heldInput: DoorInputHold
): Promise<RoomEntryResult> => {
	const info = await store.info();
	const entry = gatewayRegistry.get(info.gameId);
	if (entry === undefined) {
		return { kind: "failed", message: `Unknown game '${info.gameId}'.` };
	}
	// The minting threshold: one `guest:` actor per SSH session, minted here at
	// first room entry and reused across hops, with the upgrade box on the same
	// edge — before the guest sits down (ADR-0008).
	const assumed = context.identity.assume();
	if (assumed.minted) {
		// The adoption code is bound to this guest actor and lives seven days in
		// the gateway's own store, so it survives a restart (ADR-0005/0013).
		const minted = context.registry.mintAdoptionCode(assumed.actor);
		// The box is plain text between two screens on the session's one
		// renderer (ADR-0016), so the previous screen's frame is still on the
		// alt-screen beneath it — clear first or the box lands mid-frame.
		door.write(CLEAR_SCREEN);
		door.write(guestUpgradeBox("accepted" in minted ? minted.code : undefined));
		await awaitKeypress(door);
		// The box legitimately consumed input (awaitKeypress resumed the stream);
		// re-engage #130's hold for the stretch to Table readiness.
		heldInput.hold();
	}
	const preferences = tablePreferenceAdapter({
		actor: assumed.actor,
		keyed: context.identity.keyed,
		registry: context.registry,
		sessionPreferences: context.sessionPreferences,
	});
	const claim = await store.submit({
		actor: assumed.actor,
		command: { type: "core.claim-seat" },
	});
	if ("rejected" in claim) {
		return { kind: "failed", message: claim.message };
	}
	await runTable({
		entry,
		gameId: info.gameId,
		hold,
		// #130's internal readiness handoff: the Door holds client bytes by
		// stream backpressure until the Table's input routes and initial Pane
		// focus exist; release hands them over in arrival order.
		onInputReady: heldInput.release,
		// The session's one renderer, borrowed for this round (ADR-0016) and
		// drawn on demand: an ambient render loop here is a cost paid once per
		// seat (ADR-0012, NQ-14).
		onPreferenceChange: preferences.onPreferenceChange,
		renderer: context.renderer,
		roomLabel: info.label,
		session: sessionForActor(connection, assumed.actor),
		store,
		viewOptions: preferences.viewOptions,
	});
	return { kind: "entered" };
};

/** Which inline notice a name that has no live pipe deserves. The two halves of
 * registration answer two different questions (ADR-0012, NQ-4): the durable
 * half says whether anyone owns the name at all, the live half says whether a
 * Host pipe is carrying it right now. That split is exactly ADR-0008's
 * unknown-versus-offline distinction, and neither is ever a disconnect.
 *
 * ADR-0008 accepts knowingly that distinct copy discloses which names exist:
 * rate limiting mitigates it and names were never capability secrets. */
export const noticeForMissingRoom = (
	roomName: string,
	registry: Pick<GatewayRoomRegistry, "isClaimed">
): LobbyNotice =>
	registry.isClaimed(roomName)
		? { kind: "offline-room", roomName }
		: { kind: "unknown-room", roomName };

/** One arrival that synchronously acquired a Room slot before any work that
 * may suspend. The reservation is consumed only after linking facts arrive. */
export interface AdmittedArrival {
	readonly kind: "admitted";
	readonly reservation: RoomViewReservation;
}

/**
 * Atomically admits one arrival, or returns one of the three honest lobby
 * notices: unknown name, offline Room, or full Room (ADR-0012, NQ-10).
 *
 * Reserving is synchronous and happens before link delivery can suspend. A
 * refused arrival therefore leaves no reservation, view, or fold entry behind.
 */
export const reserveArrival = (
	roomName: string,
	live: Pick<LiveRoom, "reserveStore"> | undefined,
	registry: Pick<GatewayRoomRegistry, "isClaimed">,
	limits: Pick<CapacityLimits, "sessionsPerRoom">
): AdmittedArrival | LobbyNotice => {
	if (live === undefined) {
		return noticeForMissingRoom(roomName, registry);
	}
	const reservation = live.reserveStore(limits.sessionsPerRoom);
	return reservation === undefined
		? { kind: "full-room", roomName }
		: { kind: "admitted", reservation };
};

/** The lobby result of a table hold ending from outside the terminal. A Host
 * return starts another room attempt, while expiry and a lag-budget drop hand
 * the same session back to the lobby with an honest inline notice. */
export const noticeForRoomHoldEnd = (
	roomName: string,
	end: RoomHoldEnd | undefined
): LobbyNotice | undefined => {
	if (end === "grace-expired") {
		return { kind: "offline-room", roomName };
	}
	if (end === "dropped") {
		return { kind: "dropped-behind", roomName };
	}
};

/**
 * One attempt at sitting down, and the grace window that follows a Host dying
 * under it (ADR-0012). A drop is not a disconnect: the seat holds with an
 * honest notice while the Host redials, and the loop re-seats the player on the
 * new pipe if it makes it back inside the window. If it does not, the session
 * lands in the lobby's offline chrome — never on a closed door.
 */
const enterRoom = async (
	connection: TerminalConnection,
	door: DoorIo,
	roomName: string,
	context: RoomEntryContext
): Promise<RoomEntryResult> => {
	let attempt = 0;
	// #130: preservation starts when entry — or re-entry, on a later pass —
	// begins. After a Lobby selection this runs only once the Lobby consumed
	// the selecting key, so that key is never replayed.
	const heldInput = holdDoorInput(door.input);
	// oxlint-disable-next-line eslint/no-unreachable-loop -- a Host that returns inside the grace window continues this loop onto its new fold.
	for (;;) {
		heldInput.hold();
		const live = context.pipes.live(roomName);
		if (attempt === 0 && context.registry.isClaimed(roomName)) {
			// The tripwire's denominator counts attempts at names that exist; a
			// re-seat after a Host returned is the same join, not a new one.
			context.metrics.recordJoinAttempt(live !== undefined);
		}
		attempt += 1;
		// Unknown, offline, or full — three honest notices and never a
		// disconnect. The synchronous reservation is the capacity check and the
		// acquire, so concurrent arrivals cannot all pass one stale count.
		if (live === undefined) {
			heldInput.discard();
			return {
				kind: "notice",
				notice: noticeForMissingRoom(roomName, context.registry),
			};
		}
		const arrival = reserveArrival(
			roomName,
			live,
			context.registry,
			context.limits
		);
		if (arrival.kind !== "admitted") {
			heldInput.discard();
			return { kind: "notice", notice: arrival };
		}
		let connectionClosed = false;
		const stopWatchingClose = connection.onClose(() => {
			connectionClosed = true;
			arrival.reservation.release();
		});
		let store: RoomView | undefined;
		try {
			// The unknown-key-joins case (ADR-0005): before anyone claims a seat,
			// let the room learn whether the graph already knows the person behind
			// this key. The reservation holds capacity across this await.
			// oxlint-disable-next-line eslint/no-await-in-loop -- each attempt sits on a fresh pipe, and the fresh pipe has to be told.
			await live.deliverLinks();
			store = arrival.reservation.open();
		} finally {
			stopWatchingClose();
			// Error, disconnect, closed fold, or a future timeout: every path that
			// did not consume the reservation releases it here.
			arrival.reservation.release();
		}
		if (store === undefined) {
			if (connectionClosed) {
				return { kind: "entered" };
			}
			// The Host disappeared or superseded this fold while linking facts were
			// in flight. Re-read the live half and either re-seat or answer offline.
			continue;
		}
		const hold = holdRoom({
			attached: live,
			// The envelope half of the per-session envelope-lag budget: a view that fell
			// behind is dropped, and it is one seat's problem alone. The byte half
			// is `@opentui/ssh`'s now — its channel writes wait for the peer to
			// drain, so a client that stops reading parks its own frame feed
			// instead of growing a buffer here (#62).
			dropped: store.dropped,
			graceMs: context.graceMs,
			live: () => context.pipes.live(roomName),
			onGraceExpiry: () => context.metrics.recordGraceExpiry(),
			onHostDrop: () => context.metrics.recordHostDrop(),
			pollMs: context.gracePollMs,
		});
		let result: RoomEntryResult;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- one seat at a time: the next attempt only exists because this one ended.
			result = await runRoomTable(
				connection,
				door,
				store,
				context,
				hold,
				heldInput
			);
		} finally {
			hold.stop();
			// oxlint-disable-next-line eslint/no-await-in-loop -- the view is released before the next one opens.
			await store.close();
		}
		if (result.kind !== "entered") {
			// Entry ended before the Table was ready (#130): the held input dies
			// with the attempt — never replayed at the lobby or the closing door.
			heldInput.discard();
			return result;
		}
		const end = hold.end();
		if (end === "host-returned") {
			continue;
		}
		const notice = noticeForRoomHoldEnd(roomName, end);
		return notice === undefined ? result : { kind: "notice", notice };
	}
};

const LOBBY_FAREWELL = "the gate closes behind you.";
const TABLE_COLLAPSED_MESSAGE = "The table collapsed. Try again.";

/** What happens after one visit to the lobby: hold it again (with whatever
 * notice the attempted room entry produced), or close the door with a
 * plain-text line. */
type LobbyStep =
	| { readonly kind: "again"; readonly notice: LobbyNotice | undefined }
	| { readonly kind: "done"; readonly message: string };

/** One visit to the lobby plus whatever room entry it asked for. The idle and
 * max deadlines are armed only while the lobby holds the terminal: a player
 * sitting at a table is not squatting, and a long game is not an idle one. */
const lobbyRound = async (
	connection: TerminalConnection,
	door: DoorIo,
	notice: LobbyNotice | undefined,
	options: {
		readonly context: RoomEntryContext;
		readonly sshHost: string;
		readonly deadlines: LobbyDeadlines;
		readonly expired: () => LobbyExpiry | undefined;
		readonly untilExpiry: Promise<unknown>;
	}
): Promise<LobbyStep> => {
	const touch = (): void => options.deadlines.touch();
	options.deadlines.hold();
	door.input.on("data", touch);
	let outcome: LobbyOutcome;
	try {
		const matchedKey = options.context.identity.actor();
		outcome = await runLobby({
			connection,
			keyed: options.context.identity.keyed,
			linkMatchedKey:
				matchedKey === undefined
					? undefined
					: async (code) => {
							const linked = await options.context.registry.redeemLinkCode(
								code,
								matchedKey
							);
							return "rejected" in linked
								? linked
								: {
										accepted: true,
										whoami: options.context.registry.whoAmI(matchedKey),
									};
						},
			notice,
			renderer: options.context.renderer,
			sshHost: options.sshHost,
			until: options.untilExpiry,
			whoami: options.context.registry.whoAmI(matchedKey),
		});
	} finally {
		door.input.off("data", touch);
		options.deadlines.release();
	}
	const expiry = options.expired();
	if (expiry !== undefined) {
		return { kind: "done", message: LOBBY_EXPIRY_MESSAGE[expiry] };
	}
	if (outcome.kind === "leave") {
		return { kind: "done", message: LOBBY_FAREWELL };
	}
	const result = await enterRoom(
		connection,
		door,
		outcome.roomName,
		options.context
	);
	if (result.kind === "failed") {
		return { kind: "done", message: result.message };
	}
	return {
		kind: "again",
		notice: result.kind === "notice" ? result.notice : undefined,
	};
};

/** Everything a session needs that is the gateway's rather than the visitor's:
 * both halves of registration, the tripwire's counters, and the grace numbers. */
interface RoomServices {
	readonly registry: GatewayRoomRegistry;
	readonly pipes: HostPipeServer;
	readonly metrics: OfflineMetrics;
	/** The live keyed terminals, so a key retired right now takes the sessions
	 * it is holding with it rather than waiting for the next login. */
	readonly sessions: KeyedSessions;
	readonly limits: CapacityLimits;
	readonly graceMs?: number;
	readonly gracePollMs?: number;
}

/** Every lobby and table round of one session, on the session's one borrowed
 * renderer. Returns what the door should say on the way out, or undefined for
 * a seat that simply got up; the caller owns the goodbye's delivery and the
 * session's end. */
const shellRounds = async (
	connection: TerminalConnection,
	door: DoorIo,
	renderer: SshRenderer,
	options: {
		readonly roomName: string;
		readonly rooms: RoomServices;
		readonly identity: SessionIdentity;
		readonly sshHost: string;
		readonly limits: LobbyLimits;
	}
): Promise<string | undefined> => {
	const context: RoomEntryContext = {
		graceMs: options.rooms.graceMs,
		gracePollMs: options.rooms.gracePollMs,
		identity: options.identity,
		limits: options.rooms.limits,
		metrics: options.rooms.metrics,
		pipes: options.rooms.pipes,
		registry: options.rooms.registry,
		renderer,
		sessionPreferences: {},
	};
	// A name that resolves to a live table goes straight to the table. The lobby
	// is where you land when there is nothing to land in — which is also where
	// bare `ssh <gateway>` lands, since an SSH client with no user sends the
	// local account name and that is indistinguishable from a typed room name.
	const arrival = await enterRoom(connection, door, options.roomName, context);
	if (arrival.kind === "entered") {
		return undefined;
	}
	if (arrival.kind === "failed") {
		return arrival.message;
	}
	let expiry: LobbyExpiry | undefined;
	const expirySignal = Promise.withResolvers<boolean>();
	const deadlines = createLobbyDeadlines({
		limits: options.limits,
		onExpire: (reason) => {
			expiry = reason;
			expirySignal.resolve(true);
		},
	});
	const round = {
		context,
		deadlines,
		expired: (): LobbyExpiry | undefined => expiry,
		sshHost: options.sshHost,
		untilExpiry: expirySignal.promise,
	};
	let step: LobbyStep = { kind: "again", notice: arrival.notice };
	while (step.kind === "again") {
		// oxlint-disable-next-line eslint/no-await-in-loop -- the lobby is a held session: one visit finishes before the next room entry starts.
		step = await lobbyRound(connection, door, step.notice, round);
	}
	return step.message;
};

/** The slice of a live `@opentui/ssh` session the shell handler drives —
 * structural, so the handler stays testable without a real SSH connection. */
export interface DoorSession {
	readonly cols: number;
	readonly rows: number;
	readonly write: (data: Buffer | string) => void;
	readonly end: () => void;
	readonly onResize: (
		listener: (cols: number, rows: number) => void
	) => () => void;
	readonly onClose: (listener: () => void) => () => void;
	readonly renderer: SshRenderer;
}

export const serveShell = async (
	ssh: DoorSession,
	options: {
		readonly roomName: string;
		readonly rooms: RoomServices;
		readonly identity: SessionIdentity;
		readonly sshHost: string;
		readonly limits: LobbyLimits;
	},
	runRounds: typeof shellRounds = shellRounds
): Promise<void> => {
	const cap = options.rooms.limits.pty;
	const asked = { columns: ssh.cols, rows: ssh.rows };
	// The production PTY cap (ADR-0012, NQ-14): the library first sizes the
	// renderer to the client's PTY, clamped at its own 500x200 ceiling. Bring it
	// down before anything draws, then re-apply the R9-gated cap after every
	// library resize. Every cell above the cap is per-session gateway cost.
	const capped = clampPtySize(asked, cap);
	ssh.renderer.resize(capped.columns, capped.rows);
	const detachRecap = ssh.onResize((columns, rows) => {
		const resized = clampPtySize({ columns, rows }, cap);
		ssh.renderer.resize(resized.columns, resized.rows);
	});
	const door: DoorIo = {
		input: ssh.renderer.stdin,
		onClose: (listener) => ssh.onClose(listener),
		write: (data) => ssh.write(data),
	};
	const connection = attachDoorConnection({
		cap,
		channel: ssh,
		input: ssh.renderer.stdin,
	});
	// The library turns OpenTUI's own ctrl-c handling off — a server must never
	// let one seat's keystroke reach the process. The table's contract still
	// says ctrl-c leaves, so the Door reinstates it against this seat alone.
	ssh.renderer.keyInput.on("keypress", (key) => {
		if (key.ctrl && key.name === "c") {
			connection.close();
		}
	});
	const keyed = keyedActorOf(options.identity);
	const release =
		keyed === undefined
			? undefined
			: options.rooms.sessions.hold(keyed, () => {
					// Revocation is immediate on every surface (#59): the retired
					// key's terminal is taken down now, not at the next login.
					ssh.write(`${REVOKED_SESSION_MESSAGE}\r\n`);
					ssh.end();
				});
	try {
		if (isOversizedPty(asked, cap)) {
			// The renderer must relinquish the channel before the raw notice: resize
			// schedules a frame, and every resize while this interlude holds does too.
			ssh.renderer.suspend();
			try {
				ssh.write(oversizedTerminalNotice(asked, cap));
				await awaitKeypress(door);
			} finally {
				// A close during the wait (revocation, disconnect) destroys the
				// renderer first, and `resume()` has no destroyed guard — it would
				// call into native state that `destroy()` already freed.
				if (!ssh.renderer.isDestroyed) {
					ssh.renderer.resume();
				}
			}
		}
		const goodbye = await runRounds(connection, door, ssh.renderer, options);
		if (goodbye !== undefined) {
			// Written before the session ends, so it rides the channel ahead of
			// the teardown's screen restore; the library then drains, sends an
			// explicit exit status, and closes the channel in order.
			ssh.write(`${goodbye}\r\n`);
		}
	} catch (error) {
		ssh.write(`${TABLE_COLLAPSED_MESSAGE}\r\n`);
		throw error;
	} finally {
		release?.();
		connection.close();
		detachRecap();
		ssh.end();
	}
};

export const startGateway = async (
	options: GatewayOptions
): Promise<RunningGateway> => {
	const identity = await loadOrCreateIdentity(options.stateDir);
	const tls = await resolveGatewayTls(
		options.stateDir,
		options.tls ?? { mode: "self-signed" }
	);
	// The bind follows the TLS edge: a process that terminates its own TLS is the
	// public edge and must be reachable through the forwarded port, while a
	// process behind a proxy is reached over loopback and should be no wider
	// (#40 holds the web backend to the same line).
	const brokerBind =
		options.bindHost ?? (tls.terminatesHere ? "0.0.0.0" : "127.0.0.1");
	const listener = await startWsListener({
		advertisedUrl: options.brokerUrl,
		host: brokerBind,
		port: options.brokerPort ?? (tls.terminatesHere ? DEFAULT_PIPE_PORT : 0),
		secretKeyHex: identity.secretKeyHex,
		tls: tls.listenerTls,
	});
	const capacity = options.capacity ?? DEFAULT_CAPACITY_LIMITS;
	const registry = openRoomRegistry({
		path: path.join(options.stateDir, "registry.db"),
	});
	const identityConduit = await startIdentityConduit({
		directory: registry,
		port: options.identityConduitPort ?? 0,
	});
	const sessions = createKeyedSessions();
	/** Revocation is immediate on every surface, not just the one it was asked
	 * on: the pipe half closes the retired key's pipes, and this closes the
	 * terminals it is sitting at. */
	const onPipeEvent = (event: GatewayPipeEvent): void => {
		if (event.kind === "key-revoked") {
			sessions.drop(event.key);
		}
		options.onEvent?.(event);
	};
	const metrics = createOfflineMetrics();
	const limits = options.lobbyLimits ?? DEFAULT_LOBBY_LIMITS;
	const rateLimiter = createConnectionRateLimiter({ limits });
	const roomsReady = Promise.withResolvers<RoomServices>();
	const door = createServer({
		auth: {
			// The keyless guest door: advertised, never prompted (ADR-0008).
			keyboardInteractive: () => true,
			// The library runs the policy only after the signature over the
			// session blob verifies, so an admitted key is a proven key — and any
			// ed25519 key is an identity on first contact (ADR-0012, NQ-8).
			publicKey: { allow: admitsPublicKey },
		},
		hostKey: { path: path.join(options.stateDir, "ssh_host_ed25519_key") },
		// Whole-session idle/max reaping stays off, and deliberately: seated-idle
		// timeouts were declined (ADR-0012, dated 2026-07-25) — a player reading
		// quietly at a table is not squatting. Squatting is the lobby's problem,
		// and the lobby's own deadlines govern it.
		limits: {
			session: {
				global: capacity.doorSessionsGlobal,
				perConnection: capacity.doorSessionsPerConnection,
			},
		},
		// The library's one runtime error sink, routed to the metadata exhaust:
		// codes and counts may leave the process, messages may not (NQ-11).
		onError: (error) => {
			options.onEvent?.({ code: errorCodeOf(error), kind: "door-error" });
		},
		startupBanner: false,
	})
		.use((session, next) => requireInteractiveShell(session, next))
		.use((session, next) => {
			// Per-IP rate limiting is on from the lobby's first commit: the lobby
			// is an unauthenticated held session (ADR-0008). Refused silently,
			// exactly as the pre-handshake refusal always was.
			if (!rateLimiter.admit(session.remoteAddress.address)) {
				session.deny();
			}
			const visitIdentity = identityOf(session.identity);
			// The door's half of the revoked-key refusal (ADR-0012, NQ-3). It
			// lands here rather than in the admission policy because refusing the
			// publickey method would drop the visitor into the keyless guest path
			// — a retired key would become a guest instead of being told anything.
			// deny() speaks on the main screen: no renderer exists yet.
			const refusal = doorRefusal(visitIdentity, registry);
			if (refusal !== undefined) {
				session.deny(refusal);
			}
			return next({
				visit: { identity: visitIdentity, roomName: session.identity.username },
			});
		})
		.serve(async (session) =>
			serveShell(session, {
				identity: session.context.visit.identity,
				limits,
				roomName: session.context.visit.roomName,
				rooms: await roomsReady.promise,
				sshHost: options.sshHost,
			})
		);
	const sshListen = await door.listen(
		options.sshPort,
		options.bindHost ?? "0.0.0.0"
	);
	// The Host dials in; the gateway never dials a Host (ADR-0012). The Door
	// descriptor must carry the OS-assigned port when this process bound zero.
	const pipes = serveHostPipes({
		checkpoint: {
			create: (info) => {
				const entry = gatewayRegistry.get(info.gameId);
				return entry === undefined
					? undefined
					: createTableCheckpointProducer(entry, info.gameId);
			},
		},
		door: { sshHost: options.sshHost, sshPort: sshListen.port },
		// The key-equivalence graph reaches the broker as an injected interface,
		// never a driver: `room-wire` compiles and tests under Node too (NQ-12).
		keys: registry,
		listener,
		onEvent: onPipeEvent,
		ownership: registry,
		roomsPerIdentity: capacity.roomsPerIdentity,
		sessionBudget: capacity.sessionBudget,
	});
	roomsReady.resolve({
		graceMs: options.graceWindowMs,
		gracePollMs: options.gracePollMs,
		limits: capacity,
		metrics,
		pipes,
		registry,
		sessions,
	});
	let closePromise: Promise<void> | undefined;
	return {
		certificateFingerprint: tls.fingerprint,
		close: () => {
			closePromise ??= (async (): Promise<void> => {
				await door.close();
				await pipes.close();
				await listener.close();
				await identityConduit.close();
				registry.close();
			})();
			return closePromise;
		},
		identityConduitUrl: identityConduit.url,
		offline: () => metrics.counts(),
		pairingCode: pipePairingCode({
			advertisedUrl: options.brokerUrl,
			bindHost: brokerBind,
			boundUrl: listener.url,
			fingerprint: tls.fingerprint,
		}),
		sshPort: sshListen.port,
		url: listener.url,
	};
};

/** Reads `SUPERVILLAIN_GATEWAY_TLS`. Anything unrecognised is a refusal rather
 * than a silent fall back to the default: the difference between the modes is
 * whether production traffic is encrypted by this process, and guessing at it
 * is not a thing an operator can audit. */
const tlsFromEnvironment = (): GatewayTlsOptions => {
	const mode = process.env.SUPERVILLAIN_GATEWAY_TLS ?? "self-signed";
	if (mode === "self-signed" || mode === "terminated-upstream") {
		return { mode };
	}
	if (mode === "files") {
		const certificatePath = process.env.SUPERVILLAIN_GATEWAY_TLS_CERT;
		const privateKeyPath = process.env.SUPERVILLAIN_GATEWAY_TLS_KEY;
		if (certificatePath === undefined || privateKeyPath === undefined) {
			throw new Error(
				"SUPERVILLAIN_GATEWAY_TLS=files needs SUPERVILLAIN_GATEWAY_TLS_CERT and SUPERVILLAIN_GATEWAY_TLS_KEY."
			);
		}
		return { certificatePath, mode, privateKeyPath };
	}
	throw new Error(
		`SUPERVILLAIN_GATEWAY_TLS='${mode}' is not one of self-signed, terminated-upstream, files.`
	);
};

/** What the operator reads on start. A pairing code when this process knows the
 * address Hosts reach it at; otherwise the fingerprint plus the one variable
 * that completes it — never a code naming a wildcard bind. */
export const gatewayBanner = (
	gateway: RunningGateway,
	stateDir?: string
): string => {
	const state = stateDir === undefined ? "" : `  state:    ${stateDir}\n`;
	const door = `the gate is open.\n\n  ssh port: ${gateway.sshPort}\n${state}`;
	if (gateway.pairingCode !== undefined) {
		return `${door}  host pairing code (for supervillain create --gateway):\n\n  ${gateway.pairingCode}\n\n`;
	}
	const fingerprint =
		gateway.certificateFingerprint === undefined
			? ""
			: `  certificate fingerprint: sha256:${gateway.certificateFingerprint}\n`;
	return `${door}  the pipe is listening on ${gateway.url}\n${fingerprint}\n  set SUPERVILLAIN_GATEWAY_BROKER_URL to the address your Hosts reach this\n  box at — your domain or dynamic-DNS name and the forwarded port — and a\n  pairing code is printed here instead.\n\n`;
};

/** Resolves the first time the operator asks the gateway to stop. An
 * always-on box is stopped by a service manager (SIGTERM) at least as often as
 * by a human at a terminal (SIGINT), so both are the same event here. */
const untilShutdown = (): Promise<void> =>
	// oxlint-disable-next-line promise/avoid-new -- a process signal is an event, not a promise-returning API.
	new Promise<void>((resolve) => {
		const stop = (): void => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});

/**
 * The gateway **role**, run out of the one compiled binary (ADR-0015). This is
 * what `supervillain gateway serve` reaches, and it is the whole self-hosted
 * posture: the SSH door, the broker Hosts dial out to, the gateway's own store,
 * and — since the default TLS mode is `self-signed` — a certificate it mints
 * for itself, so a clean box needs no CA, no domain, and no proxy. No web
 * surface, no publishing: those are hosted-only at v1 (ADR-0013).
 */
export const serveGateway = async (
	args: readonly string[]
): Promise<number> => {
	const parsed = parseGatewayRoleArgs(args, {
		env: process.env,
		homeDir: homedir(),
	});
	if (parsed.kind === "help") {
		console.log(GATEWAY_ROLE_USAGE);
		return 0;
	}
	if (parsed.kind === "error") {
		console.error(parsed.message);
		console.error(GATEWAY_ROLE_USAGE);
		return 1;
	}
	let tls: GatewayTlsOptions;
	let capacity: GatewayCapacity;
	try {
		tls = tlsFromEnvironment();
		// The caps are ops-tunable and read here, not compiled in (ADR-0012,
		// NQ-10): a box with more headroom than the benchmark's raises them, and
		// a smaller one lowers them, without a rebuild.
		capacity = capacityFromEnvironment(process.env);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	// A clean box has no state directory yet; the gateway makes its own rather
	// than demanding a provisioning step (ADR-0015's clean-box criterion).
	await mkdir(parsed.options.stateDir, { mode: 0o700, recursive: true });
	const gateway = await startGateway({
		...parsed.options,
		capacity: capacity.limits,
		identityConduitPort: DEFAULT_IDENTITY_CONDUIT_PORT,
		lobbyLimits: capacity.lobby,
		tls,
	});
	process.stdout.write(gatewayBanner(gateway, parsed.options.stateDir));
	await untilShutdown();
	await gateway.close();
	return 0;
};

if (import.meta.main) {
	process.exitCode = await serveGateway(process.argv.slice(2));
}
