import { isFingerprint } from "./keys.ts";

const GUEST = /^guest:[A-Za-z0-9_-]{1,64}$/u;

export const isRelayableActor = (actor: string): boolean =>
	(actor.startsWith("key:") && isFingerprint(actor.slice(4))) ||
	GUEST.test(actor);

const INVITE = /^[A-Za-z0-9_-]{1,64}$/u;

export const isRelayableInvite = (token: string): boolean => INVITE.test(token);

const BUCKET = /^[A-Za-z0-9_-]{43}$/u;

export const isRelayableBucket = (bucket: string): boolean =>
	BUCKET.test(bucket);
