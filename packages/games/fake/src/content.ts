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

/** The fake module keeps the same strings-only publish seam as real games. */
export const snapshotCharacter = (bytes: Uint8Array, name: string) => {
	const validated = validate(bytes);
	if (!validated.ok) {
		throw new Error(validated.errors[0]?.message ?? "Fake content is invalid.");
	}
	return {
		card: {
			accentHint: "accent" as const,
			description: "Fake game character",
			fields: [],
			glyph: "F",
			title: name,
		},
		sections: [
			{
				fields: [
					{
						label: "Content",
						value: new TextDecoder().decode(bytes),
					},
				],
				title: "Character",
			},
		],
	};
};

export const content = { snapshotCharacter, validate };
