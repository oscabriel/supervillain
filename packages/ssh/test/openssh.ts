import { join } from "node:path";
import { Effect } from "effect";

/** The real OpenSSH client and ssh-keygen, kept away from the user's config, agent and known_hosts. */

export interface ClientKey {
  readonly path: string;
  /** What `ssh-keygen -lf <key>.pub` prints, e.g. `SHA256:…`. */
  readonly fingerprint: string;
}

const run = async (cmd: ReadonlyArray<string>) => {
  const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const fingerprintFile = async (path: string) => {
  const listed = await run(["ssh-keygen", "-lf", path]);
  const fingerprint = listed.stdout.split(" ")[1];
  if (!fingerprint?.startsWith("SHA256:"))
    throw new Error(`ssh-keygen -lf ${path}: ${listed.stderr}`);
  return fingerprint;
};

/** A fresh key pair in `dir` (ed25519 unless asked), with the fingerprint ssh-keygen reports for it. */
export const clientKey = (
  dir: string,
  name: string,
  type: "ed25519" | "rsa" | "ecdsa" = "ed25519",
) =>
  Effect.promise(async (): Promise<ClientKey> => {
    const path = join(dir, name);
    const made = await run(["ssh-keygen", "-q", "-t", type, "-N", "", "-C", name, "-f", path]);
    if (made.exitCode !== 0) throw new Error(`ssh-keygen: ${made.stderr}`);
    return { path, fingerprint: await fingerprintFile(`${path}.pub`) };
  });

/** The fingerprint `ssh-keygen -lf` prints for a key file. */
export const keygenFingerprint = (path: string) => Effect.promise(() => fingerprintFile(path));

export interface ClientOptions {
  /** Authenticate with this key; without one the client offers no key at all. */
  readonly key?: ClientKey;
  /** The ssh username, i.e. the room. */
  readonly user?: string;
  /** Extra ssh flags, placed before the host, e.g. `["-o", "KexAlgorithms=…"]` or `["-T"]`. */
  readonly flags?: ReadonlyArray<string>;
}

const env = () => {
  const { SSH_AUTH_SOCK: _, ...rest } = process.env;
  return rest;
};

const baseArgs = (port: number, options: ClientOptions, flags: ReadonlyArray<string> = []) => [
  "ssh",
  ...flags,
  ...(options.flags ?? []),
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
  ...(options.key
    ? ["-o", "BatchMode=yes", "-i", options.key.path]
    : ["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no"]),
  "-l",
  options.user ?? "den",
  "127.0.0.1",
];

/** Runs `ssh … 127.0.0.1 <command>` to completion. */
export const sshExec = (
  port: number,
  command: ReadonlyArray<string>,
  options: ClientOptions = {},
) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([...baseArgs(port, options), ...command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  });

export interface Terminal {
  /** Everything the client has printed so far. */
  readonly output: () => string;
  /** Resizes the client's terminal; ssh sends a window-change. */
  readonly resize: (cols: number, rows: number) => void;
  /** Types into the client's terminal. */
  readonly write: (text: string) => void;
  /** Kills the client process, as a dropped connection would. */
  readonly kill: () => void;
  /** Freezes the client process (SIGSTOP), as a laptop lid closing would; `resume` thaws it. */
  readonly pause: () => void;
  readonly resume: () => void;
  readonly exited: Promise<number>;
}

/** Runs `ssh -tt` in a real pseudo-terminal of the given size, for the life of the scope. */
export const sshShell = (
  port: number,
  size: { cols: number; rows: number },
  options: ClientOptions,
) =>
  Effect.acquireRelease(
    Effect.sync((): Terminal => {
      let output = "";
      const decoder = new TextDecoder();
      const proc = Bun.spawn(baseArgs(port, options, ["-tt"]), {
        env: { ...env(), TERM: "xterm-256color" },
        terminal: {
          cols: size.cols,
          rows: size.rows,
          data: (_terminal, data) => {
            output += decoder.decode(data, { stream: true });
          },
        },
      });
      return {
        output: () => output,
        resize: (cols, rows) => proc.terminal?.resize(cols, rows),
        write: (text) => void proc.terminal?.write(text),
        kill: () => proc.kill("SIGKILL"),
        pause: () => proc.kill("SIGSTOP"),
        resume: () => proc.kill("SIGCONT"),
        exited: proc.exited,
      };
    }),
    (terminal) =>
      Effect.promise(async () => {
        terminal.resume();
        terminal.kill();
        await terminal.exited;
      }),
  );

/** Polls until `predicate` holds, failing the test after `ms`. */
export const waitFor = (what: string, predicate: () => boolean, ms = 3000) =>
  Effect.promise(async () => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  });
