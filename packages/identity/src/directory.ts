/**
 * ADR-0013's identity seam: **a TypeScript interface, not an HTTP contract.**
 *
 * Two implementations are foreseen. _Local_ reads the gateway's own store
 * in-process; the gateway uses it, and so would a web role co-located with a
 * self-hosted gateway. _Remote_ is a call to the gateway, which is what the
 * hosted web backend will use on the cold publish path — it does not exist yet
 * and belongs to `apps/web`.
 *
 * The interface is deliberately narrow: two questions, both **local reads** for
 * the gateway. They must answer with no network, no backend process, and our
 * servers unreachable — that is the whole point of putting the key-equivalence
 * graph in the gateway's SQLite (ADR-0013), and it is why both methods are
 * synchronous here. Anything that has to await is the remote implementation's
 * problem, not this contract's.
 */
export interface IdentityDirectory {
	/**
	 * The identity an actor already belongs to, or undefined when the graph has
	 * never seen it. A read, never a mint: minting an identity for an unknown
	 * key is the registration path's business, not this one's.
	 *
	 * The argument is an *actor* string, not strictly a key: an adopted
	 * `guest:X` resolves through the same call, which is what makes one
	 * `core.actor-linked` event serve device linking and guest adoption alike.
	 */
	readonly identityOf: (actor: string) => string | undefined;
	/** Whether this key has been retired (ADR-0012, NQ-3). An unknown key is
	 * not revoked — it is merely unknown. */
	readonly isRevoked: (key: string) => boolean;
}
