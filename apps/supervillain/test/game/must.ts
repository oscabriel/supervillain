export const must = <A>(value: A | null | undefined, why = "a value"): A => {
	if (value === undefined || value === null) {
		throw new Error(`expected ${why}`);
	}

	return value;
};
