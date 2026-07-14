export const terminology = {
  visit: "visit",
} as const;

export function validate(bytes: Uint8Array) {
  if (bytes.byteLength > 0) {
    return { ok: true } as const;
  }

  return {
    ok: false,
    errors: [{ message: "Fake content must not be empty." }],
  } as const;
}

export const content = { validate };
