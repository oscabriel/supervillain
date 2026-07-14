export const terminology = {
	visit: "visit",
} as const;

export const validate = (bytes: Uint8Array) => {
	if (bytes.byteLength > 0) {
		return { ok: true } as const;
	}

	return {
		errors: [{ message: "Fake content must not be empty." }],
		ok: false,
	} as const;
};

export const content = { validate };
