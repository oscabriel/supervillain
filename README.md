# supervillain

A terminal-first virtual tabletop for Draw Steel. Players type `ssh <room>@<host>` and are sitting at a live table, with nothing to install and no account to make. The GM's machine is the authority, and the campaign is a plain append-only log on the GM's disk.

It's being rebuilt small, and there is nothing to install yet. `ASSESSMENT.md` is the plan. The previous build is at tag `archive/2026-09-exploration`.

## Develop

```sh
bun install
bun run build
bun test
bun run check
```

## License

[MIT](LICENSE).

---

supervillain is an independent product published under the DRAW STEEL Creator License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026 MCDM Productions, LLC.
