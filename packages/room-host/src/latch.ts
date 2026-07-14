/** A one-shot latch: `released` resolves once `release()` is called. Releasing twice is a no-op. */
export class Latch {
	readonly released: Promise<void>;
	#release!: () => void;

	constructor() {
		// oxlint-disable-next-line promise/avoid-new -- a resolver latch is the primitive that async sequencing is built from
		this.released = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	release(): void {
		this.#release();
	}
}
