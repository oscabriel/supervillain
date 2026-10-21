import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import ssh2, { type ParsedKey } from "ssh2";

/** OpenSSH's SHA256 fingerprint of a public-key blob: what `ssh-keygen -lf` prints, e.g. `SHA256:nThb…`. */
export const fingerprintOf = (publicKeyBlob: Buffer): string =>
  `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`;

/** Whether text is an OpenSSH SHA256 key fingerprint, as `fingerprintOf` makes and `ssh-keygen -lf` prints. */
export const isFingerprint = (text: string): boolean => /^SHA256:[A-Za-z0-9+/]{43}$/.test(text);

/**
 * Elliptic-curve key exchange only, offered by the server and the client alike. ssh2 also offers
 * finite-field groups up to 8192 bits, and one such handshake costs the host's only thread
 * seconds of CPU before anyone has logged in.
 */
export const KEX: Array<ssh2.KexAlgorithm> = [
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
];

/** Parses one key in any form ssh2 reads (PEM, OpenSSH, an authorized_keys line), or undefined. */
export const parseKey = (input: string | Buffer): ParsedKey | undefined => {
  const parsed = ssh2.utils.parseKey(input);
  if (parsed instanceof Error) return undefined;
  return Array.isArray(parsed) ? parsed[0] : parsed;
};

interface HostKey {
  readonly pem: Buffer;
  readonly fingerprint: string;
}

// ssh2's keygen now and then emits a key its own parser rejects, so it retries.
// Adapted from @opentui/ssh 0.6.6, MIT.
const generateEd25519 = (): string => {
  for (let i = 0; i < 20; i++) {
    const pem = ssh2.utils.generateKeyPairSync("ed25519").private;
    if (parseKey(pem)) return pem;
  }
  throw new Error("could not generate a parseable ed25519 host key");
};

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Reads the host key at `path`, or generates an ed25519 key there first (owner-only, mode 0600).
 * The new key is written to a temporary file and linked into place, so two hosts racing get one key.
 * A key other users can read is refused, as sshd refuses one: anyone who has it can pose as this host.
 */
export async function loadHostKey(path: string): Promise<HostKey> {
  let pem = await readFile(path).catch((e: unknown) => {
    if (isMissing(e)) return undefined;
    throw e;
  });
  if (pem === undefined) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, generateEd25519(), { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await link(temporary, path).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    pem = await readFile(path);
  }
  if (((await stat(path)).mode & 0o077) !== 0)
    throw new Error(`${path} can be read by other users; run chmod 600 ${path}`);
  const key = parseKey(pem);
  if (!key) throw new Error(`cannot read the host key at ${path}`);
  return { pem, fingerprint: fingerprintOf(key.getPublicSSH()) };
}
