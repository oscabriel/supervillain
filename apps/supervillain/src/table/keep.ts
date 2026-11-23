const isPlain = <A>(value: A): value is NonNullable<A> =>
	value !== null &&
	value !== undefined &&
	Object.getPrototypeOf(value) === Object.prototype;

const isComposite = <A>(value: A): value is NonNullable<A> =>
	Array.isArray(value) || isPlain(value);

const fieldsOf = <A>(value: NonNullable<A>): ReadonlyMap<string, unknown> =>
	new Map(Object.entries(value));

const sameKind = <A, B>(candidate: B, next: A): candidate is A & B =>
	Array.isArray(candidate) && Array.isArray(next)
		? candidate.length === next.length
		: isPlain(candidate) && isPlain(next);

export const kept = <A>(previous: A | undefined, next: A): A => {
	if (previous === next) {
		return next;
	}

	if (
		!isComposite(previous) ||
		!isComposite(next) ||
		Array.isArray(previous) !== Array.isArray(next)
	) {
		return next;
	}

	const was = fieldsOf(previous);
	const now = fieldsOf(next);

	const moved = Array.isArray(previous)
		? new Map([...was.values()].map((v) => [JSON.stringify(v), v]))
		: undefined;

	let same = now.size === was.size;

	const pairs = [...now].map(([key, value]) => {
		const reused =
			moved?.get(JSON.stringify(value)) ?? kept(was.get(key), value);

		if (reused !== was.get(key) || !was.has(key)) {
			same = false;
		}

		return [key, reused] as const;
	});

	if (same) {
		return previous;
	}

	const out = Array.isArray(next)
		? pairs.map(([, value]) => value)
		: Object.fromEntries(pairs);

	return sameKind(out, next) ? out : next;
};
