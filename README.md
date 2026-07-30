# supervillain

A terminal-first virtual tabletop. Players `ssh` into a live game room; the GM hosts the table from their own machine — one downloaded file, no runtime to install. Draw Steel is the first game module on a system-agnostic core.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/oscabriel/supervillain/main/install.sh | sh
```

This installs the `supervillain` binary and a `vil` short alias; both identify as supervillain.

Then `supervillain create` to host a table, and hand your players:

```sh
ssh <room>@supervillain.app
```

GM platforms: Linux (x64, arm64) and macOS (Apple Silicon and Intel); Windows GMs, use WSL2. Players just need an `ssh` client, on any OS.

### Pin the key SSH offers

SSH offers keys one at a time, and the gateway must accept or reject each key before it can see the next one. If your agent holds several keys, the first accepted key may resolve to a different identity than the one you intended. The Lobby's `whoami` screen reports the key fingerprint the gateway matched and the other key fingerprints linked to its identity.

Pin the intended key for the gateway in `~/.ssh/config`:

```sshconfig
Host supervillain.app
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519_supervillain
```

Replace the host and key path when using a self-hosted gateway. `IdentitiesOnly yes` makes SSH offer only the configured key; it does not identify a person. If `whoami` shows the wrong key, use “link this key too” on that Lobby screen, or reconnect after correcting this stanza.

## Guides

- [Write and validate battle-map files](docs/maps.md)

## Decision record

This repo carries its own decision history: the product definition, glossary, and architectural decision records live under [`.agents/`](.agents/), starting from [`.agents/wayfinder/assets/product-definition.md`](.agents/wayfinder/assets/product-definition.md).

## License

[MIT](LICENSE).

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC.
