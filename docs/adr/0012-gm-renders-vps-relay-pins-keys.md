# GM machine renders every seat; relay forwards bytes, pins keys, and runs on a small VPS

## Decision

`supervillain host` runs the rules and renders every player's OpenTUI seat on the GM's machine. `supervillain relay` runs on a small Linux VPS (e.g. $5/mo Vultr, 1 vCPU, 512 MB RAM) listening on two TCP ports (players on 22/2222, GMs dialing out on 7022). The relay renders nothing except its ANSI lobby screen, pins room ownership in `rooms.json` (180-day lapse, per-`/64` and `/48` claim rates, 1,024 max rooms, mode `0700` dir), and answers lobby lookups via `knows-1@supervillain.sh` using a 16-byte random nonce and HMAC-SHA256 of the player's actor. GMs pin the relay's key in `relay_known` synchronously inside `admitRelay` *before* authenticating the link.

## Why

- Rendering on the GM's machine keeps campaign logs, sheets, and compute off the relay.
- Synchronous pre-admit pinning guarantees an unwritable `relay_known` never authenticates an unpinned relay.
- Nonce+HMAC lobby probes let a host confirm keys it already knows without learning unknown keys.
- Evaluating Cloudflare Inbound TCP Workers (Spectrum `connect()` + Containers) showed it requires a Pro ($20/mo) or Business ($200/mo) zone, allows strictly 1 Worker-origin TCP port per zone (blocking our 2-port relay without rewriting GM links to WebSockets), cannot run `ssh2` natively in `workerd`, hits 15-minute Durable Object socket eviction caps, and bills 24/7 Container memory continuously—making a $5 VPS vastly cheaper, simpler, and more reliable.

## What breaks if you change this

- Writing `relay_known` asynchronously after `admitRelay` returns `true` opens a window where an unpinned relay can seat arbitrary `key:SHA256:...` actors.
- Dropping the nonce+MAC scheme and sending raw player keys in lobby queries leaks which players are online to every linked GM.
- Allowing group/world write permissions on the relay directory lets another local user swap `rooms.json` and hijack room claims.
