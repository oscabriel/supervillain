import { join } from "node:path";
import { Effect } from "effect";

/** The real OpenSSH client and ssh-keygen, kept away from the user's config, agent and known_hosts. */

export interface ClientKey {
  readonly path: string;
  /** What `ssh-keygen -lf <key>.pub` prints, e.g. `SHA256:…`. */
  readonly fingerprint: string;
}

const run = async (cmd: ReadonlyArray<string>) => {
  const proc = Bun.spawn([...cmd], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env() });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const env = () => {
  const { SSH_AUTH_SOCK: _, ...rest } = process.env;
  return rest;
};

/** A fresh ed25519 key pair in `dir`, with the fingerprint ssh-keygen reports for it. */
export const clientKey = (dir: string, name: string) =>
  Effect.promise(async (): Promise<ClientKey> => {
    const path = join(dir, name);
    const made = await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
    if (made.exitCode !== 0) throw new Error(`ssh-keygen: ${made.stderr}`);
    const listed = await run(["ssh-keygen", "-lf", `${path}.pub`]);
    const fingerprint = listed.stdout.split(" ")[1];
    if (!fingerprint?.startsWith("SHA256:")) throw new Error(`ssh-keygen -lf: ${listed.stderr}`);
    return { path, fingerprint };
  });

const args = (port: number, key: ClientKey | undefined, flags: ReadonlyArray<string> = []) => [
  "ssh",
  ...flags,
  "-F",
  "/dev/null",
  "-p",
  String(port),
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "IdentityAgent=none",
  "-o",
  "IdentitiesOnly=yes",
  ...(key
    ? ["-o", "BatchMode=yes", "-i", key.path]
    : ["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no"]),
  "den@127.0.0.1",
];

/** Runs `ssh … den@127.0.0.1 <command>` to completion; without a key the client is a guest. */
export const sshExec = (port: number, command: string, key?: ClientKey) =>
  Effect.promise(() => run([...args(port, key), command]));

export interface Terminal {
  /** Everything the client has printed so far, escape sequences removed. */
  readonly text: () => string;
  readonly write: (text: string) => void;
  /** Kills the client, as a dropped connection would. */
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

/** Runs `ssh -tt` in a real 100x30 pseudo-terminal for the life of the scope. */
export const sshShell = (port: number, key?: ClientKey) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let output = "";
      const decoder = new TextDecoder();
      const proc = Bun.spawn(args(port, key, ["-tt"]), {
        env: { ...env(), TERM: "xterm-256color" },
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, data) => {
            output += decoder.decode(data, { stream: true });
          },
        },
      });
      const terminal: Terminal = {
        text: () => Bun.stripANSI(output),
        write: (text) => void proc.terminal?.write(text),
        kill: () => proc.kill("SIGKILL"),
        exited: proc.exited,
      };
      return { terminal, proc };
    }),
    ({ proc }) =>
      Effect.promise(async () => {
        proc.kill("SIGKILL");
        await proc.exited;
      }),
  ).pipe(Effect.map(({ terminal }) => terminal));

/** Polls until `predicate` holds, failing the test after `ms`. */
export const waitFor = (what: string, predicate: () => boolean, ms = 5000) =>
  Effect.promise(async () => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  });
