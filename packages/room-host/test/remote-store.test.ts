/* oxlint-disable vitest/prefer-importing-vitest-globals -- dual-lane suite; the harness picks bun:test or vitest at runtime. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Envelope, HostRegistry } from "@supervillain/core";
import { openIrohEndpoint } from "@supervillain/transport-iroh";
import type {
	IrohEndpointOptions,
	TransportEndpoint,
} from "@supervillain/transport-iroh";

import { decide } from "../../games/fake/src/authority.js";
import { apply, eventTypes, init } from "../../games/fake/src/model.js";
import { InProcessRoomStore, RoomHost } from "../src/index.js";
import { describe, expect, test } from "./harness.js";
import { connectRoomStore, serveRoomStore } from "./remote.js";

type RemoteStore = Awaited<ReturnType<typeof connectRoomStore>>;
type ServerHandle = ReturnType<typeof serveRoomStore>;

interface RemoteFixture {
	readonly dialer: TransportEndpoint;
	readonly remote: RemoteStore;
	readonly server: ServerHandle;
	readonly servingEndpoint: TransportEndpoint;
}

const registry: HostRegistry = {
	get(gameId) {
		return gameId === "fake"
			? {
					authority: { decide },
					grammar: { eventTypes },
					model: { apply, init },
				}
			: undefined;
	},
};

const timestamps = [
	"2026-01-01T00:00:00.000Z",
	"2026-01-01T00:00:01.000Z",
	"2026-01-01T00:00:02.000Z",
	"2026-01-01T00:00:03.000Z",
];

const clockAt = (start = 0): (() => string) => {
	let index = start;
	return () => {
		const value = timestamps[index];
		index += 1;
		return value ?? "2026-01-01T00:00:59.000Z";
	};
};

const withCampaign = async (
	run: (folder: string) => Promise<void>
): Promise<void> => {
	const folder = await mkdtemp(
		path.join(tmpdir(), "supervillain-remote-store-")
	);
	try {
		await run(folder);
	} finally {
		await rm(folder, { force: true, recursive: true });
	}
};

const openFixture = async (
	campaignFolder: string,
	options: IrohEndpointOptions
): Promise<RemoteFixture> => {
	const host = await RoomHost.open({
		actor: "actor-gm",
		campaignFolder,
		clock: clockAt(),
		gameId: "fake",
		registry,
	});
	const servingEndpoint = await openIrohEndpoint(options);
	let dialer: TransportEndpoint;
	try {
		dialer = await openIrohEndpoint(options);
	} catch (error) {
		await servingEndpoint.close();
		throw error;
	}
	const server = serveRoomStore(servingEndpoint, new InProcessRoomStore(host));
	try {
		const remote = await connectRoomStore(dialer, servingEndpoint.address);
		return { dialer, remote, server, servingEndpoint };
	} catch (error) {
		await server.close();
		await dialer.close();
		throw error;
	}
};

const closeFixture = async (fixture: RemoteFixture): Promise<void> => {
	await fixture.remote.close();
	await fixture.server.close();
	await fixture.dialer.close();
	await fixture.servingEndpoint.close();
};

const nextEnvelope = async (
	iterator: AsyncIterator<Envelope>
): Promise<Envelope> => {
	const result = await iterator.next();
	if (result.done === true) {
		throw new Error("RoomStore stream ended before the expected Envelope.");
	}
	return result.value;
};

const captureRejection = async (
	promise: Promise<unknown>
): Promise<unknown> => {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
};

const visit = {
	actor: "actor-gm",
	command: { seatId: "gm", type: "fake.visit" },
} as const;

describe("remote RoomStore over iroh", () => {
	test("connects a second peer to a live host over a direct route", async () => {
		await withCampaign(async (campaignFolder) => {
			const fixture = await openFixture(campaignFolder, { routing: "direct" });
			try {
				await fixture.remote.submit({
					actor: "actor-guest",
					command: { type: "core.claim-seat" },
				});
				const submission = await fixture.remote.submit({
					actor: "actor-guest",
					command: { seatId: "player-1", type: "fake.visit" },
				});
				expect(submission).toMatchObject({
					accepted: true,
					envelopes: [{ seq: 4 }, { seq: 5 }],
				});

				const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
				try {
					const envelopes = [
						await nextEnvelope(iterator),
						await nextEnvelope(iterator),
						await nextEnvelope(iterator),
						await nextEnvelope(iterator),
						await nextEnvelope(iterator),
					];
					expect(envelopes.map(({ seq, type }) => ({ seq, type }))).toEqual([
						{ seq: 1, type: "core.room-created" },
						{ seq: 2, type: "core.seat-claimed" },
						{ seq: 3, type: "core.seat-claimed" },
						{ seq: 4, type: "fake.seat-observed" },
						{ seq: 5, type: "fake.visit-counted" },
					]);
				} finally {
					await iterator.return?.();
				}
			} finally {
				await closeFixture(fixture);
			}
		});
	}, 30_000);

	test("connects the live host through a forced relay", async () => {
		await withCampaign(async (campaignFolder) => {
			const fixture = await openFixture(campaignFolder, { routing: "relay" });
			try {
				expect(await fixture.remote.submit(visit)).toMatchObject({
					accepted: true,
				});
				const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
				try {
					expect(await nextEnvelope(iterator)).toMatchObject({
						seq: 1,
						type: "core.room-created",
					});
				} finally {
					await iterator.return?.();
				}
			} finally {
				await closeFixture(fixture);
			}
		});
	}, 60_000);

	test("reconnects a stream for catch-up and then follows live Envelopes", async () => {
		await withCampaign(async (campaignFolder) => {
			const fixture = await openFixture(campaignFolder, { routing: "direct" });
			try {
				const initial = fixture.remote.stream(1)[Symbol.asyncIterator]();
				try {
					expect(await nextEnvelope(initial)).toMatchObject({ seq: 1 });
				} finally {
					await initial.return?.();
				}

				await fixture.remote.submit(visit);

				const reconnected = fixture.remote.stream(2)[Symbol.asyncIterator]();
				try {
					const missed = [
						await nextEnvelope(reconnected),
						await nextEnvelope(reconnected),
						await nextEnvelope(reconnected),
					];
					expect(missed.map(({ seq, type }) => ({ seq, type }))).toEqual([
						{ seq: 2, type: "core.seat-claimed" },
						{ seq: 3, type: "fake.seat-observed" },
						{ seq: 4, type: "fake.visit-counted" },
					]);

					const liveEnvelope = nextEnvelope(reconnected);
					await fixture.remote.submit(visit);
					expect(await liveEnvelope).toMatchObject({
						seq: 5,
						type: "fake.seat-observed",
					});
				} finally {
					await reconnected.return?.();
				}
			} finally {
				await closeFixture(fixture);
			}
		});
	}, 30_000);

	test("closes while a live stream read is pending", async () => {
		await withCampaign(async (campaignFolder) => {
			const fixture = await openFixture(campaignFolder, { routing: "direct" });
			const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
			try {
				expect(await nextEnvelope(iterator)).toMatchObject({ seq: 1 });
				expect(await nextEnvelope(iterator)).toMatchObject({ seq: 2 });
				const pendingEnvelope = captureRejection(iterator.next());
				await delay(25);

				await fixture.server.close();
				expect(await pendingEnvelope).toBeInstanceOf(Error);
			} finally {
				await closeFixture(fixture);
				await iterator.return?.();
			}
		});
	}, 30_000);

	test("shuts the remote store, server, and endpoints down idempotently", async () => {
		await withCampaign(async (campaignFolder) => {
			const fixture = await openFixture(campaignFolder, { routing: "direct" });
			try {
				expect(await fixture.remote.submit(visit)).toMatchObject({
					accepted: true,
				});
				const iterator = fixture.remote.stream(1)[Symbol.asyncIterator]();
				try {
					expect(await nextEnvelope(iterator)).toMatchObject({ seq: 1 });
				} finally {
					await iterator.return?.();
				}

				await closeFixture(fixture);
			} finally {
				await closeFixture(fixture);
			}
		});
	}, 30_000);
});
