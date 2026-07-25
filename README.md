# supervillain

A terminal-first virtual tabletop. Players `ssh` into a live game room; the GM
hosts the table from their own machine — one downloaded file, no runtime to
install. Draw Steel is the first game module on a system-agnostic core.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/oscabriel/supervillain/main/install.sh | sh
```

Then `supervillain create` to host a table, and hand your players:

```sh
ssh <room>@supervillain.app
```

## Decision record

This repo carries its own decision history: the product definition, glossary,
and architectural decision records live under [`.agents/`](.agents/), starting
from [`.agents/wayfinder/assets/product-definition.md`](.agents/wayfinder/assets/product-definition.md).

## License

[MIT](LICENSE).

---

supervillain is an independent product published under the DRAW STEEL Creator
License and is not affiliated with MCDM Productions, LLC. DRAW STEEL © 2026
MCDM Productions, LLC.
