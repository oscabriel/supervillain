---
title: Hosting a table
summary: Your machine is the table. Install one binary, make a campaign folder, and choose how players reach you.
order: 2
---

Your machine is the table. `supervillain host` runs an SSH server on it, keeps the campaign log in your campaign folder and gives you the GM's seat in the terminal you started it from. Players need only `ssh`; send them [Playing at a table](/docs/playing).

## Install

Each release has one self-contained executable per platform, plus `SHA256SUMS`. It needs nothing else installed.

| File | For |
| --- | --- |
| `supervillain-linux-x64` | Linux on Intel or AMD (glibc) |
| `supervillain-linux-arm64` | Linux on ARM (glibc), such as a Raspberry Pi 4 or 5 or an ARM VPS |
| `supervillain-darwin-arm64` | macOS on Apple silicon |
| `supervillain-darwin-x64` | macOS on Intel |

```sh
sha256sum --ignore-missing -c SHA256SUMS
sudo install -m 0755 supervillain-linux-x64 /usr/local/bin/supervillain
supervillain --version
```

Replace the file name with your platform's. If you download with a browser on macOS, the file is quarantined; clear that with `xattr -d com.apple.quarantine supervillain-darwin-arm64`.

To run from source instead, install [Bun](https://bun.sh), run `bun install` in a checkout, then `bun supervillain …` from its root.

## Start a table

```sh
supervillain new ~/campaigns/first-fight --example
supervillain host ~/campaigns/first-fight
```

`new --example` copies the sample campaign: four heroes, the bandits and the map for one fight. Without `--example` you get a `campaign.yaml` and empty `heroes/`, `monsters/` and `maps/` folders. `host` refuses a path that isn't a campaign, so a typo can't start an empty table under a new host key.

`host` prints what to send your players:

```text
supervillain: hosting "first-fight" from /home/you/campaigns/first-fight, playing draw-steel
players join with: ssh -p 2222 first-fight@127.0.0.1
host key SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk
```

Send players the join command, with your address in place of `127.0.0.1`, and the host key. When ssh first connects it shows them that fingerprint, and comparing the two is how they know they reached you. Ctrl-C at your seat closes the table.

| Option | What it does |
| --- | --- |
| `--port 2222` | The port players connect to; `0` picks a free one |
| `--bind 127.0.0.1` | The address to listen on; `0.0.0.0` listens on every network |
| `--room <name>` | The room's name, which players type before the `@`; it defaults to the folder's name |
| `--relay host[:7022]` | Also take players through a relay |
| `--relay-key SHA256:…` | The relay key to trust |
| `--no-lobby` | Keeps the table off the relay's lobby |

## The campaign folder

The folder is yours alone (mode 700). Beside `campaign.yaml` and what you put in it, the host writes:

- `events.jsonl`: the log, one event per line. It holds every word said at the table. A write that fails is cut back, leaving the log as it was, and the table refuses every change after it until you restart.
- `host_key`: the table's SSH identity. Keep it, or players' ssh will warn that the key changed.
- `events.lock`: while a host runs, so only one host at a time writes to a campaign.
- `host.log`: what the host did.
- `relay_known`: the relay key this campaign trusts.

`supervillain check ~/campaigns/first-fight` replays a log without opening the table: a summary, skipped events, the feed and the final state. It exits 1 if the log has an event it can't apply.

## Preparing a game

At your seat, Alt+5 or `/prep` opens the GM prep panel, a column right of the map and the feed. It walks the steps to a fight (a map, the party, the foes, then start), and lists every map, hero and monster in the campaign folder. A click sends the very line you could type, so the log can't tell a click from typing. `/map new crossing 7` generates a map into `maps/` from a seed and loads it.

## Three ways in

By default the table listens only on this machine (`127.0.0.1:2222`).

### Same network, or Tailscale

```sh
supervillain host ~/campaigns/first-fight --bind 0.0.0.0
```

Players connect with your LAN address or your tailnet name. With [Tailscale](https://tailscale.com), invite each player to your tailnet or share this one machine; no ports are opened to the internet. Your firewall has to let in TCP 2222.

### A tunnel

SSH is plain TCP, so the tunnel has to forward TCP. [bore](https://github.com/ekzhang/bore) needs no signup:

```sh
bore local 2222 --to bore.pub
```

It prints a public port, and players run `ssh -p <port> first-fight@bore.pub`. Or forward through a VPS you already have with `ssh -N -R 0.0.0.0:2222:127.0.0.1:2222 you@your.vps`, with `GatewayPorts clientspecified` in that server's sshd config.

A Cloudflare tunnel won't do: a quick tunnel carries only HTTP, and a named one needs every player to install `cloudflared`. That breaks "nothing to install".

### The relay, on a small VPS

The relay gives your table a permanent address, `ssh -p 2222 <room>@table.example.com`. Your host dials out to the relay, so your machine opens no port and can be anywhere. The relay takes players' SSH connections and passes each one down that link. Your machine still renders every screen and keeps the log.

Any small Linux VPS works: 1 vCPU and 512 MB is plenty. On it:

```sh
supervillain relay --dir /var/lib/supervillain-relay --bind 0.0.0.0 --player-port 2222 --gm-port 7022
```

It prints two fingerprints: the relay key, which GMs pin, and the host key, which players' ssh sees. Open TCP 2222 and 7022 in the firewall. Then, at home:

```sh
supervillain host ~/campaigns/first-fight \
  --relay table.example.com --relay-key SHA256:<the relay key>
```

One relay serves any number of rooms, and each room belongs to the GM host key that first linked it. A dropped link is redialed with backoff. A player who comes back to the relay without a room's name is shown the open tables that already know their key.

**What the relay sees.** Players' SSH ends at the relay, so the relay sees every keystroke and every frame in the clear, though it keeps none of it. It also vouches for every player it brings: your host takes the relay's word for which key each relayed player holds. A pinned relay can't be spoofed by anyone else, but whoever runs it can read your table. Run your own, or use one you trust.

## Other rulesets

```sh
supervillain new ~/campaigns/arena --rules set-world
supervillain host ~/campaigns/arena
```

A set.world campaign has no sheets to write, only `maps/`. At the table you name each fighter and roll it (`/recruit Ada 101`, `/foe Grub 501`), and the host fetches the roll from set.world, giving up after 10 seconds. The roll goes into the log, so the table never asks again, even when it reopens. Use `/auto foes on` to let the host run enemy turns automatically.

```sh
supervillain new ~/campaigns/delve --rules pf2e
supervillain import pathbuilder ~/Downloads/ari.json ~/campaigns/delve
supervillain host ~/campaigns/delve
```

A `pf2e` campaign runs open Remaster tactical rules under the ORC licence, with PCs in `heroes/` and creatures in `monsters/`. See [Rulesets](/docs/rulesets).
