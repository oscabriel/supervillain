import {
	ROOM_NAME_FIRST_WORDS,
	ROOM_NAME_SECOND_WORDS,
} from "./room-name-words.js";

const MAX_GENERATED_NAME_ATTEMPTS = 5;

type RegistrationResult<T> =
	| { readonly value: T }
	| { readonly failed: string };

type GeneratedRegistrationResult<T> =
	| { readonly name: string; readonly value: T }
	| { readonly failed: string };

const pick = <T>(values: readonly T[], random: () => number): T =>
	values[Math.floor(random() * values.length)] as T;

/**
 * A local default removes a naming decision from a GM who just wants to play,
 * while making ADR-0008's accepted room-name enumeration disclose less for
 * free. It never asks a gateway for suggestions or availability.
 */
export const generateRoomName = (random: () => number = Math.random): string =>
	`${pick(ROOM_NAME_FIRST_WORDS, random)}-${pick(ROOM_NAME_SECOND_WORDS, random)}`;

const isNameCollision = (name: string, message: string): boolean =>
	message === `The name '${name}' is already claimed by another key.`;

/** Retry belongs only to generated names; an explicit GM choice never enters
 * this function and therefore keeps the gateway's refusal unchanged. */
export const registerGeneratedName = async <T>(options: {
	readonly generate?: () => string;
	readonly register: (name: string) => Promise<RegistrationResult<T>>;
}): Promise<GeneratedRegistrationResult<T>> => {
	const generate = options.generate ?? generateRoomName;
	for (let attempt = 0; attempt < MAX_GENERATED_NAME_ATTEMPTS; attempt += 1) {
		const name = generate();
		// oxlint-disable-next-line eslint/no-await-in-loop -- each collision chooses the next name before another registration.
		const registration = await options.register(name);
		if ("value" in registration) {
			return { name, value: registration.value };
		}
		if (!isNameCollision(name, registration.failed)) {
			return registration;
		}
	}
	return {
		failed: `Could not find an available room name after ${MAX_GENERATED_NAME_ATTEMPTS} attempts.`,
	};
};
