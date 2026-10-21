const PLAYER_KEY = /^key:SHA256:[A-Za-z0-9+/]{43}$/;
const GUEST = /^guest:[A-Za-z0-9_-]{1,64}$/;

/** Whether a relay may seat this actor: a player key or a guest, never `gm` or anything else. */
export const isRelayableActor = (actor: string): boolean =>
  PLAYER_KEY.test(actor) || GUEST.test(actor);
