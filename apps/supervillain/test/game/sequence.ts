export const inOrder = async <A>(
	items: Iterable<A>,
	step: (item: A, index: number) => Promise<void>
): Promise<void> => {
	const walk = async (
		entries: ReadonlyArray<readonly [number, A]>
	): Promise<void> => {
		const [head, ...rest] = entries;

		if (head === undefined) {
			return;
		}

		await step(head[1], head[0]);
		await walk(rest);
	};

	await walk([...[...items].entries()]);
};

export const times = async (
	count: number,
	step: (index: number) => Promise<void>
): Promise<void> => {
	await inOrder(
		Array.from({ length: count }, (_, i) => i),
		async (i) => {
			await step(i);
		}
	);
};
