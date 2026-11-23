export const when = <A extends object>(
	condition: boolean,
	build: () => A
): Partial<A> => (condition ? build() : {});

export const ifDefined = <V, A extends object>(
	value: V | undefined,
	build: (value: V) => A
): Partial<A> => (value === undefined ? {} : build(value));

export const listIf = <A>(
	condition: boolean,
	build: () => ReadonlyArray<A>
): ReadonlyArray<A> => (condition ? build() : []);

export const listIfDefined = <V, A>(
	value: V | undefined,
	build: (value: V) => ReadonlyArray<A>
): ReadonlyArray<A> => (value === undefined ? [] : build(value));

export const orEmpty = <A>(
	items: ReadonlyArray<A> | undefined
): ReadonlyArray<A> => items ?? [];
