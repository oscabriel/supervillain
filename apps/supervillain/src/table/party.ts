import { clip } from "./prose.ts";
import type { PartyMember } from "./view.ts";

export type PartyTone =
	| "name"
	| "mine"
	| "player"
	| "healthy"
	| "winded"
	| "dying"
	| "dim"
	| "tag";

export interface PartySegment {
	readonly text: string;
	readonly tone: PartyTone;
}

export interface PartyRow {
	readonly id: string;
	readonly segments: ReadonlyArray<PartySegment>;
}

export const PARTY_FRAME = { width: 4, height: 2 } as const;

const PARTY_MIN = 3;

const METER_CELLS = 8;

const NAME_MOST = 24;

export const meterTone = (
	value: number,
	max: number,
	down: boolean
): PartyTone => {
	if (down || value <= 0) {
		return "dying";
	}

	return value * 2 <= max ? "winded" : "healthy";
};

export const meter = (value: number, max: number, cells: number): string => {
	const share = max <= 0 ? 0 : value / max;
	const filled = Math.max(0, Math.min(cells, Math.round(share * cells)));

	return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
};

const widthOf = (segments: ReadonlyArray<PartySegment>): number =>
	segments.reduce((n, s) => n + Bun.stringWidth(s.text), 0);

const healthOf = (member: PartyMember): ReadonlyArray<PartySegment> => {
	const { health } = member;

	if (health === undefined) {
		return member.down ? [{ text: "  down", tone: "dying" }] : [];
	}

	const tone = meterTone(health.value, health.max, member.down);

	return [
		{ text: `  ${health.label} `, tone: "dim" },
		{ text: meter(health.value, health.max, METER_CELLS), tone },
		{ text: ` ${health.value}/${health.max}`, tone },
	];
};

export const partyRow = (member: PartyMember, width: number): PartyRow => {
	const name: PartySegment = {
		text: clip(member.name, Math.min(NAME_MOST, width)),
		tone: member.mine ? "mine" : "name",
	};

	const optional: ReadonlyArray<ReadonlyArray<PartySegment>> = [
		member.player === undefined
			? []
			: [{ text: ` (${member.player})`, tone: "player" }],
		member.free ? [{ text: " · free", tone: "dim" }] : [],
		healthOf(member),
		member.tags.length === 0
			? []
			: [{ text: `  ${member.tags.join(", ")}`, tone: "tag" }],
		member.summary === "" ? [] : [{ text: `  ${member.summary}`, tone: "dim" }],
	];

	const segments: Array<PartySegment> = [name];

	for (const more of optional) {
		if (more.length > 0 && widthOf([...segments, ...more]) <= width) {
			segments.push(...more);
		}
	}

	return { id: member.id, segments };
};

export const partyRows = (
	members: ReadonlyArray<PartyMember>,
	width: number
): ReadonlyArray<PartyRow> => members.map((m) => partyRow(m, width));

export const partyWanted = (members: ReadonlyArray<PartyMember>): number =>
	Math.max(PARTY_MIN, members.length + PARTY_FRAME.height);

export const sheetLine = (id: string): string => `/sheet ${id}`;
