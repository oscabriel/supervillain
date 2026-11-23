import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

import ssh2 from "ssh2";
import type { ParsedKey } from "ssh2";

import { errnoOf } from "./errno.ts";
import { kexAlgorithm } from "./ssh2Internals.ts";

export const fingerprintOf = (publicKeyBlob: Buffer): string =>
	`SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/[=]+$/u, "")}`;

export const isFingerprint = (text: string): boolean =>
	/^SHA256:[A-Za-z0-9+/]{43}$/u.test(text);

export const KEX: Array<ssh2.KexAlgorithm> = [
	kexAlgorithm("mlkem768x25519-sha256"),
	"curve25519-sha256",
	"curve25519-sha256@libssh.org",
	"ecdh-sha2-nistp256",
	"ecdh-sha2-nistp384",
	"ecdh-sha2-nistp521",
];

export const IDENT = "supervillain";

export const COMPRESS: Array<ssh2.CompressionAlgorithm> = ["none"];

export const parseKey = (input: string | Buffer): ParsedKey | undefined => {
	try {
		const parsed = ssh2.utils.parseKey(input);

		if (parsed instanceof Error) {
			return undefined;
		}

		return [parsed].flat().at(0);
	} catch {
		return undefined;
	}
};

interface HostKey {
	readonly pem: Buffer;
	readonly fingerprint: string;
}

const generateEd25519 = (): string => {
	for (let i = 0; i < 20; i += 1) {
		const pem = ssh2.utils.generateKeyPairSync("ed25519").private;

		if (parseKey(pem)) {
			return pem;
		}
	}

	throw new Error("could not generate a parseable ed25519 host key");
};

const readIfThere = async (file: string): Promise<Buffer | undefined> => {
	try {
		return await readFile(file);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") {
			return undefined;
		}

		throw error;
	}
};

const linkUnlessThere = async (from: string, to: string): Promise<void> => {
	try {
		await link(from, to);
	} catch (error) {
		if (errnoOf(error) !== "EEXIST") {
			throw error;
		}
	}
};

const unlinkIfThere = async (file: string): Promise<boolean> => {
	try {
		await unlink(file);

		return true;
	} catch {
		return false;
	}
};

const OTHERS_BITS = 0o100;

export const loadHostKey = async (keyPath: string): Promise<HostKey> => {
	let pem = await readIfThere(keyPath);

	if (pem === undefined) {
		await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
		const temporary = `${keyPath}.${process.pid}.${Date.now()}.tmp`;

		try {
			await writeFile(temporary, generateEd25519(), {
				mode: 0o600,
				flag: "wx",
			});
			await chmod(temporary, 0o600);
			await linkUnlessThere(temporary, keyPath);
		} finally {
			await unlinkIfThere(temporary);
		}

		pem = await readFile(keyPath);
	}

	const { mode } = await stat(keyPath);

	if (mode % OTHERS_BITS !== 0) {
		throw new Error(
			`${keyPath} can be read by other users; run chmod 600 ${keyPath}`
		);
	}

	const key = parseKey(pem);

	if (!key) {
		throw new Error(`cannot read the host key at ${keyPath}`);
	}

	return { pem, fingerprint: fingerprintOf(key.getPublicSSH()) };
};
