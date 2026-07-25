/**
 * The key-equivalence graph as a fold sees it (ADR-0005). The gateway owns the
 * authoritative graph (ADR-0013); a room owns only the slice its own log states,
 * one `core.actor-linked` event at a time.
 *
 * Historical envelopes are never rewritten: a `guest:X` line written months ago
 * keeps its actor forever, and adoption only makes that actor *reachable* — the
 * union answers "same person", the log stays byte-identical.
 */

/** One room's actor equivalence classes, folded from `core.actor-linked`. */
export interface ActorLinks {
	/** Unions two actor strings. Idempotent, order-free, and transitive. */
	readonly link: (actor: string, linked: string) => void;
	/** Records an actor with no linking claim — a class of one until some
	 * later event says otherwise. */
	readonly remember: (actor: string) => void;
	/** Whether two actor strings name the same person in this log. */
	readonly same: (left: string, right: string) => boolean;
	/** Every actor unioned with this one, itself included, first-seen first.
	 * An actor the log never linked is a class of one. */
	readonly members: (actor: string) => readonly string[];
	/** Every actor string this graph has ever been told about, first-seen
	 * first — the roster a Host offers the gateway at registration. */
	readonly actors: () => readonly string[];
}

export const createActorLinks = (): ActorLinks => {
	// Insertion-ordered class membership; the parent map is the union-find.
	const parent = new Map<string, string>();
	const classes = new Map<string, string[]>();
	const seen: string[] = [];

	const add = (actor: string): string => {
		if (!parent.has(actor)) {
			parent.set(actor, actor);
			classes.set(actor, [actor]);
			seen.push(actor);
		}
		return actor;
	};

	const find = (actor: string): string => {
		add(actor);
		let root = actor;
		let next = parent.get(root);
		while (next !== undefined && next !== root) {
			root = next;
			next = parent.get(root);
		}
		// Path compression keeps a long link chain from costing more each read.
		let walk = actor;
		let step = parent.get(walk);
		while (step !== undefined && step !== walk) {
			parent.set(walk, root);
			walk = step;
			step = parent.get(walk);
		}
		return root;
	};

	return {
		actors: () => [...seen],
		link: (actor, linked) => {
			const left = find(actor);
			const right = find(linked);
			if (left === right) {
				return;
			}
			const absorbed = classes.get(right) ?? [right];
			const kept = classes.get(left) ?? [left];
			parent.set(right, left);
			classes.delete(right);
			classes.set(left, [...kept, ...absorbed]);
		},
		members: (actor) => {
			const root = find(actor);
			return [...(classes.get(root) ?? [actor])];
		},
		remember: (actor) => {
			add(actor);
		},
		same: (left, right) => find(left) === find(right),
	};
};
