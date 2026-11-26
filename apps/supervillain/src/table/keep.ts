const isPlain = <A>(value: A): value is NonNullable<A> =>
	value !== null &&
	value !== undefined &&
	Object.getPrototypeOf(value) === Object.prototype;

const isComposite = <A>(value: A): value is NonNullable<A> =>
	Array.isArray(value) || isPlain(value);

const fieldsOf = <A>(value: NonNullable<A>): ReadonlyMap<string, unknown> =>
	new Map(Object.entries(value));

const alike = <A>(candidate: unknown, next: A): candidate is A => {
	if (Object.is(candidate, next)) {
		return true;
	}

	if (
		!isComposite(candidate) ||
		!isComposite(next) ||
		Array.isArray(candidate) !== Array.isArray(next)
	) {
		return false;
	}

	const mine = fieldsOf(candidate);
	const theirs = fieldsOf(next);

	return (
		mine.size === theirs.size &&
		[...theirs].every(
			([key, value]) => mine.has(key) && alike(mine.get(key), value)
		)
	);
};

interface Mended {
	readonly value: unknown;
}

const mended = <A>(previous: A, next: A): Mended => {
	if (
		previous === next ||
		!isComposite(previous) ||
		!isComposite(next) ||
		Array.isArray(previous) !== Array.isArray(next)
	) {
		return { value: next };
	}

	const was = fieldsOf(previous);
	const now = fieldsOf(next);

	const moved = Array.isArray(previous)
		? new Map([...was.values()].map((v) => [JSON.stringify(v), v]))
		: undefined;

	let same = now.size === was.size;

	const pairs = [...now].map(([key, value]) => {
		const reused =
			moved?.get(JSON.stringify(value)) ?? mended(was.get(key), value).value;

		if (reused !== was.get(key) || !was.has(key)) {
			same = false;
		}

		return [key, reused] as const;
	});

	if (same) {
		return { value: previous };
	}

	return {
		value: Array.isArray(next)
			? pairs.map(([, value]) => value)
			: Object.fromEntries(pairs),
	};
};

export const kept = <A>(previous: A | undefined, next: A): A => {
	const made = mended(previous, next);

	if (previous !== undefined && made.value === previous) {
		return previous;
	}

	return alike(made.value, next) ? made.value : next;
};
