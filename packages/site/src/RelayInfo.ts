import { Option, Schema } from "effect";

export interface RelayInfo {
	readonly host: string;
	readonly publicKey: string;
	readonly fingerprint: string;
	readonly knownHostsLine: string;
}

export interface ParsedPublicKey {
	readonly algorithm: string;
	readonly keyData: string;
}

const DEFAULT_HOST = "supervillain.sh";

const ALGORITHMS: ReadonlySet<string> = new Set([
	"ssh-ed25519",
	"ssh-rsa",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
]);

export const parsePublicKey = (raw: string): ParsedPublicKey | undefined => {
	const tokens = raw
		.trim()
		.split(/\s+/u)
		.filter((token) => token !== "");

	for (const [index, token] of tokens.entries()) {
		const next = tokens[index + 1];

		if (ALGORITHMS.has(token) && next !== undefined && next.length > 0) {
			return { algorithm: token, keyData: next };
		}
	}

	return undefined;
};

export const relayInfoFrom = (
	host: string,
	publicKey: string,
	fingerprint: string
): RelayInfo => {
	const cleanHost = host.trim() === "" ? DEFAULT_HOST : host.trim();
	const parsed = parsePublicKey(publicKey);

	if (parsed === undefined) {
		return {
			host: cleanHost,
			publicKey: "",
			fingerprint: fingerprint.trim(),
			knownHostsLine: "",
		};
	}

	const normalized = `${parsed.algorithm} ${parsed.keyData}`;

	return {
		host: cleanHost,
		publicKey: normalized,
		fingerprint: fingerprint.trim(),
		knownHostsLine: `${cleanHost} ${normalized}`,
	};
};

const RelayEnv = Schema.Struct({
	VITE_RELAY_HOST: Schema.optionalKey(Schema.String),
	VITE_RELAY_HOST_KEY: Schema.optionalKey(Schema.String),
	VITE_RELAY_FINGERPRINT: Schema.optionalKey(Schema.String),
});

const decodeRelayEnv = Schema.decodeUnknownOption(RelayEnv);

export const RELAY_INFO: RelayInfo = Option.match(
	decodeRelayEnv(import.meta.env),
	{
		onNone: () => relayInfoFrom("", "", ""),
		onSome: (env) =>
			relayInfoFrom(
				env.VITE_RELAY_HOST ?? "",
				env.VITE_RELAY_HOST_KEY ?? "",
				env.VITE_RELAY_FINGERPRINT ?? ""
			),
	}
);
