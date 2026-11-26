# Hosting a supervillain table

Your machine is the table. `supervillain host` runs an SSH server on it, keeps the campaign log in your campaign folder and gives you the GM's seat in the terminal you started it from. Players need only `ssh`; send them [PLAYING.md](PLAYING.md).

This page covers installing the binary, starting a table, and the three ways players can reach it:

1. the same network or a Tailscale tailnet;
2. a tunnel (bore, or `ssh -R` through a server you rent);
3. the relay, on a small VPS of your own.

## Install

Install the latest release binary with checksum verification (fails closed on mismatch):

```sh
curl -fsSL https://supervillain.sh/install | sh
supervillain
```

Running bare `supervillain` in a terminal opens the interactive local GM launcher: it scans `./` and `~/supervillain` for campaigns, provides a built-in New Table wizard, and links your table to `supervillain.sh` under your handle (pass `--local` to run locally without a relay).

Each release also ships one self-contained executable per platform plus `SHA256SUMS` on GitHub Releases:

| File | For |
| --- | --- |
| `supervillain-linux-x64` | Linux on Intel or AMD (glibc) |
| `supervillain-linux-arm64` | Linux on ARM (glibc), e.g. a Raspberry Pi 4 or 5 on a 64-bit OS, or an ARM VPS |
| `supervillain-darwin-arm64` | macOS on Apple silicon |
| `supervillain-darwin-x64` | macOS on Intel |

The repository is private for now, so download with the GitHub CLI while signed in:

```sh
gh release download -R oscabriel/supervillain -p supervillain-linux-x64 -p SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS      # macOS: shasum -a 256 --ignore-missing -c SHA256SUMS
sudo install -m 0755 supervillain-linux-x64 /usr/local/bin/supervillain
supervillain --version
```

That fetches the latest release; put a tag after `download` for another (`gh release list -R oscabriel/supervillain`). Replace the file name with your platform's. Downloading with `gh` or `curl` is fine on macOS. If you download with a browser, macOS quarantines the file and won't open it. Clear that with `xattr -d com.apple.quarantine supervillain-darwin-arm64`.

To run from source instead, run `bun install` in a checkout, then `bun supervillain …` from its root. To build the binary yourself, run `bun run release:build` there. That writes `dist/supervillain-<os>-<arch>` for your machine. Use `--all` for every platform after `bun install --os="*" --cpu="*"`.

## Start a table

```sh
supervillain new ~/campaigns/first-fight --example
supervillain host ~/campaigns/first-fight
```

`new --example` copies the sample campaign: four heroes, the bandits and the map for one fight. Without `--example` you get a `campaign.yaml` and empty `heroes/`, `monsters/` and `maps/` folders (only `maps/` with `--rules set-world`). The folder's README explains the file formats. `host` opens a campaign folder and refuses one that isn't there (`there's no campaign at …; make one with: supervillain new …`), and a folder with none of `campaign.yaml`, `events.jsonl`, `host_key`, `heroes/`, `monsters/` or `maps/` in it (`… isn't a campaign: …`), so a mistyped path never starts an empty table under a new host key, and your home folder never gets a log.

`new <name> --open` (or `--claim sv-…`, which opens too) makes the folder under `SUPERVILLAIN_HOME` (else `~/supervillain`) and opens it on a relay at once: `--relay host:port`, else `SUPERVILLAIN_RELAY`, `gm.json`, then `supervillain.sh:7022`. `--handle` sets your handle and replaces the one `gm.json` holds. The handle, the table's name and the relay are checked before anything is written, so a bad one leaves neither a folder nor `gm.json` behind. Tables opened this way, or from the bare `supervillain` launcher, pin the relay's key in `<config>/supervillain/relay_known`, one file for all of them; the launcher's `--local` and `--relay` don't go together.

`supervillain map crossing <campaign> --seed 7` (or `keep`) generates a map into `maps/` and says how to load it, and at the table `/map new crossing 7` does the same and loads it (see [Preparing a game](#preparing-a-game)); the campaign README has how maps work.

### What the campaign plays

A campaign plays one ruleset, declared in `table.md` frontmatter (or legacy `campaign.yaml`): `rules: draw-steel`, `rules: set-world`, `rules: pf2e`, or `rules: freeform`. `new` writes it (`draw-steel` unless you pass `--rules`), and a campaign without one plays Draw Steel. Naming `rules:` in both `table.md` and `campaign.yaml` is rejected.

Campaign content uses typed Markdown (`.md` with Effect-Schema-validated YAML frontmatter) across `table.md`, `party/`, `npcs/`, `monsters/`, `scenes/`, `handouts/`, `items/`, `ancestries/`, `classes/`, and `abilities/`, alongside `maps/*.txt` (and backward-compatible `heroes/*.yaml` / `monsters/*.yaml`). Anything under `## GM Notes` (or `## Director's Notes`, `## DM Notes`, `## Secrets`, and HTML comments) is stripped automatically from every player view and never enters `events.jsonl`. Run `supervillain check <dir>` to validate all files, cross-references, and the log, or `supervillain schema <dir>` to emit JSON Schemas for editors and agents. While a table runs, `ContentWatch` hot-reloads valid edits cleanly and never crashes on broken edits.

For `rules: freeform` (lightweight narrative and custom-stat tables), see [docs/rulesets/freeform.md](rulesets/freeform.md).

While your table is running, it also opens a private `0600` local agent socket (`mcp.sock`) so you can connect an AI co-GM via `supervillain mcp <campaign-dir>` (or remote GMs via `gm_keys`). See [docs/AGENTS-SETUP.md](AGENTS-SETUP.md).

**set.world** ([set.world](https://set.world)) rolls characters from a seed over its free API: a class with its flavor, a weapon, nine stats, the attributes the fight reads and named gear. A set.world campaign has no sheets to write, only `maps/`:

```sh
supervillain new ~/campaigns/arena --rules set-world
supervillain host ~/campaigns/arena
```

At the table you name each fighter and roll it, and the host fetches the roll from set.world (it needs the network then, and gives up after 10 seconds). The roll goes into the log, so the table never asks set.world again for it, even when it reopens. The same seed always rolls the same character; leave the seed out and the host picks one, which the feed shows.

| Command | What it does |
| --- | --- |
| `/recruit Ada 101`, `/foe Grub 501` | Roll a party member or a foe at set.world, by seed or at random |
| `/map ford-road`, `/place ada b5` | Load a map from `maps/` and put fighters on it; the map is optional |
| `/start`, `/end` | Start the fight, or end it early |
| `/move grub n6`, `/attack grub ada`, `/done` | Act for any fighter on its turn; `/done` ends the turn, a rest if it didn't attack |
| `/auto foes [on\|off]` | Let the host drive foes automatically on their turns (pauses on `/undo`) |
| `/unplay ada` | Free a party member a player holds |

The fight follows Set's turn-based rules (stamp `set-world-0-15-0-dungeon-initiative-2`): each fighter acts every `1000 / initiative` milliseconds of a logical clock, so there are no rounds, and an exact tie goes to the party first; everyone recovers 10 stamina a second of that clock; an attack costs 20 stamina, hit or miss; a hit is a dodge draw against `dodgeRate × (1 − clarity)`, a critical draw against `criticalHitChance` that doubles it, and `max(1, floor(raw × (1 − reduction) × (1 − globalResistance)))`. Set's own fights have no positions, so the grid's rules are the table's: speed is `round(5 × walkSpeed)` squares a turn; a weapon reaches by how it delivers (melee 1 square, 2 past 40 inches of reach; projectiles 10; waves 5 and auras 3, which hit as magic, with `magicalDamage` against `magicalDamageReduction`), checked only when both fighters are on the map. When the last of one side falls the fight is over; stamina then refills and health stays as it is. Expect long fights: hits of 7 to 19 against 150 to 230 health.

**`pf2e` (ORC Remaster)** runs open Remaster tactical rules under the ORC License (`docs/ORC-NOTICE.md`), with PCs in `heroes/` and creatures in `monsters/`:

```sh
supervillain new ~/campaigns/delve --rules pf2e
supervillain import pathbuilder ~/Downloads/ari.json ~/campaigns/delve
supervillain host ~/campaigns/delve
```

At the table, bring PCs in with `/pc <id>`, add creatures with `/add <id> [xN] [elite|weak]`, load a map and place tokens, then `/start` to roll initiative (Perception by default, or an alternate skill). See [docs/rulesets/pf2e.md](rulesets/pf2e.md) for the complete command reference.

`host` prints what to send your players:

```
supervillain: hosting "first-fight" from /home/you/campaigns/first-fight, playing draw-steel
players join with: ssh -p 2222 first-fight@127.0.0.1
host key SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk
```

Send players the join command, with your address in place of `127.0.0.1` (see below), and the host key. When ssh first connects it shows them that fingerprint, and comparing the two is how they know they reached you. Your seat covers that output once it opens, so while you sit alone its band shows `players join with: ssh -p 2222 first-fight@127.0.0.1 · host key SHA256:…`, and the end of `/help` and `host.log` have both too. Ctrl-C at your seat closes the table. While players are seated it asks you to press it again, and any other key, paste, click or wheel in between calls that off.

At your seat, `/narrate <text>` describes the scene in the feed with no speaker, and `/state` shows or hides the table's state and its latest log lines, raw.

If the port is taken, by another table say, `host` says so and stops: `port 2222 on 127.0.0.1 is in use (another table?); pick another with --port, or --port 0 for any free one`.

| Option | What it does |
| --- | --- |
| `--port 2222` | The port players connect to, 0 to 65535. `0` picks a free one |
| `--bind 127.0.0.1` | The IP address to listen on, or `localhost`. The default lets in only this machine and tunnels running on it; `0.0.0.0` listens on every network |
| `--table <name>` | The table's name, which players type after your handle on a relay. It defaults to the campaign folder's name; `--room` still works |
| `--door knock\|open` | Whether newcomers knock (the default for a new table) or sit straight down; it's kept in the log, like `/door`. See [Letting players in](#letting-players-in) |
| `--handle <you>` | Your GM handle on a relay: players join with `ssh <handle>/<table>@…`. Needed with `--relay` |
| `--claim sv-…` | A claim code that adds this machine to a handle another of your machines holds; see [Handles](#handles) |
| `--headless` | Runs without the GM's seat, with logs on stdout. Nobody has GM powers, so this is for trying a server, not for running a game |
| `--relay host[:7022]` | Also take players through a relay; see [3. The relay](#3-the-relay-on-a-small-vps) |
| `--relay-key SHA256:…` | The relay key to trust, instead of the one in `relay_known` |
| `--relay-player-port 22` | The relay's player port, for the join command you're shown |
| `--relay-host-key SHA256:…` | The relay's host key, shown with that join command so you can pass it on to players |
| `--no-lobby` | Keeps the table off the relay's lobby; see [The lobby](#the-lobby) |

The campaign folder is yours alone (mode 700). Beside `campaign.yaml` and what you put in it, the host writes these files into it:

- `events.jsonl`: the log, one event per line. It holds every word said at the table. A write that fails (a full disk, say) is cut back, leaving the log as it was, and the table refuses every change after it until you restart the host.
- `host_key`: the table's SSH identity. Keep it, or players' ssh will warn that the key changed.
- `events.lock`: while a host runs, so only one host at a time writes to a campaign. The next host takes over a lock whose host has died. A second host that gets in anyway writes nothing: its first write finds the log changed, and it halts.
- `host.log`: what the host did, when you have the GM's seat.
- `relay_known`: the relay key this campaign trusts, written on the first link to a relay (the `--relay-key`, if you passed one).

The host refuses a `host_key` other users can read (`chmod 600` it). Players are capped so one stranger can't take the table down: 8 connections and 16 sessions from one address, 64 of each in all, 20 new sessions from one address and then 1 a second, 20 seconds to log in, and a few lines a second per player. A connection that stops reading, leaving more than 4 MiB waiting, or rekeys over and over, is cut, and the host's log says so.

`supervillain check ~/campaigns/first-fight` reads a log without opening the table: a summary, skipped events, the feed and the final state.

### Letting players in

A new table's door is set to knock. Someone who connects for the first time doesn't see the table: they see its door, pick the name the table should call them (checked like `/name`), and knock. The top of your seat then shows the oldest knock with the start of the knocker's key fingerprint, `⚑ Ana (ab12cd34) knocks · [Admit] [Deny]`, and how many more wait. Click a button, press Alt+Y or Alt+N, or type `/admit Ana` or `/deny Ana` (Tab completes who is knocking; the fingerprint's first characters name them too). Let in, they sit down at once and the feed says `Ana joins the table.`. Turned away, they're told so, and neither their key nor their address can knock again for 10 minutes; through a relay, the relay tells your host which knocks share an address without saying what it is, so a new key or a guest from the same place waits too. A knock nobody answers ends after 10 minutes, someone who sits at the door for 2 minutes without knocking is sent off, and a host holds 16 knocks at most, one a key and three an address. If two knockers pick the same name, `/admit` and `/deny` say so and list their fingerprints' starts, so name one by its fingerprint. Knocks are never written to the log; who you let in, and as what name, is.

From then on a player's key comes straight in. `/kick Ana` removes them: their seat closes and they must knock to come back, even with an invite. `/door open` seats anyone who connects, as tables did before knocking, and `/door knock` sets it back, closing the seats of anyone it let in who never played; `--door` on `host` does the same at start. A campaign from before knocking keeps everyone who already played at it.

`/invite [uses] [minutes]` makes an invite for players you'd rather not wait on: 1 use and 60 minutes unless you say, up to 32 uses and a day. Your seat shows the join command with the token after a `~` (`ssh ana/first-fight~5k2q…@table.example.com`); whoever joins with it names themself at the door and sits straight down. A use counts only once they're in. Invites live only in your host's memory, so they end when it stops. One-off commands (`ssh … roll 2d10`) work only for players already let in; a stranger's is refused on stderr.

## Preparing a game

At your seat, Alt+5 or `/prep` opens the GM prep panel, a column right of the map and the feed. It is the GM's alone: a player's Alt+5 or `/prep` is told so. Each time it opens it reads `heroes/`, `monsters/` and `maps/` again, so a sheet you saved a minute ago is there, and a file that won't load is listed by its id (loading it says why). A click sends the very line you could type, so the log can't tell a click from typing, and Up brings back what a click sent; the hint row says what the next square clicked will send. Nothing in the panel changes the table by itself, and you can go on typing commands as before.

Top to bottom, the panel shows:

- **The steps to a fight**: map, party, foes, then ▶. Each is ◆ when done (a map loaded; everyone on each side on it), and the one to do now is lit.
- **What the next square does**: who or what goes on the map when you click a free square on it, drawn as its token, with a bar and ⌖. While something waits the panel's border is red, and in terminals that draw pointer shapes the pointer is a crosshair. Once everyone is placed this is **fight**, which sends `/start` and puts the panel away; in a fight it says the round.
- **map**: the loaded map, with ↻ to generate another of its kind (`/map new keep`, for a generated one) and ⇄ to choose again. Until one is loaded, every map in `maps/`, then + crossing and + keep (`/map new keep`) and + by seed, which puts `/map new ` on the input line for a kind and a seed. Put away sends `/map off`.
- **to place**: whoever is in play and off the map, heroes first. The next square places the first (`/place brann b6`), so placing a party is a click a square; click one in the list to place it next instead.
- **heroes** (Draw Steel): the campaign's heroes not yet in play. A click sends `/hero brann`, and that hero is next for a square. + all brings every one in.
- **monsters** (Draw Steel): every stat block, with how many are in play (`×2`). Each click counts one more (`+3`), − one fewer; the next square then sends `/add bandit-cutpurse x3` and places what it added on the free squares nearest that square (a squad of minions is one token). Esc puts the count down.
- **fighters** (set.world): + Recruit or + Foe puts `/recruit ` or `/foe ` on the input line: type the name and, if you like, a seed, then Enter. The fighter is then next for a square.

A click on a token on the map still opens its menu, as it does without the panel; a token placed in the wrong square goes elsewhere with a typed `/place brann c4`. The panel takes a third of the seat's columns, between 26 and 34, and the map and the feed draw beside it; its list scrolls with the wheel. Alt+5 or a click on its title hides it again; hidden, the hint row offers `⁵ prep` to click. Each token is drawn as the picture map draws it in a terminal with kitty graphics, and in blocks anywhere else.

`/map new crossing|keep [seed]` makes a map at the table the way `supervillain map` does, through the same code: it writes `maps/<kind>-<seed>.txt`, picking a seed when you leave it out, then loads it as `/map <id>` would. The event carries the grid, as every `/map` does, so replay never generates or reads the file. The seed is in the map's id, and a kind and seed always make the same map; one whose file is already in `maps/` (in any letter case) is refused with the `/map` that loads it. A map you generate is the panel's map at once, and the one it replaced stays in the list behind ⇄.

## 1. Same network, or Tailscale

If your players are on your network, or on your [Tailscale](https://tailscale.com) tailnet, listen on every interface:

```sh
supervillain host ~/campaigns/first-fight --bind 0.0.0.0
```

Players connect with your machine's LAN address, or its tailnet name or `100.x.y.z` address:

```sh
ssh -p 2222 first-fight@gm-laptop          # Tailscale MagicDNS name
ssh -p 2222 first-fight@192.168.1.20       # LAN address
```

With Tailscale, invite each player to your tailnet, or share just this machine with them from the admin console. They need the Tailscale app, but no ports are opened and nothing is exposed to the internet. The table doesn't use Tailscale SSH, so leave that setting as it is.

A firewall on your machine has to let in TCP 2222. On macOS, allow incoming connections for `supervillain` when it asks. On Linux with ufw, run `sudo ufw allow 2222/tcp`.

## 2. A tunnel

A tunnel gives your table a public address while it keeps listening only on `127.0.0.1`. SSH is plain TCP, so the tunnel has to forward TCP.

**bore** (free, nothing to sign up for):

```sh
supervillain host ~/campaigns/first-fight            # in one terminal
bore local 2222 --to bore.pub                        # in another
```

bore prints `listening at bore.pub:41234`, and players run `ssh -p 41234 first-fight@bore.pub`. The port changes every time unless you pass `--port`, which fails if someone else has that port. bore.pub is a public server run by bore's author. To use your own, run `bore server` on a VPS and `bore local 2222 --to your.vps`. Install bore with `brew install bore-cli`, `cargo install bore-cli` or a binary from its releases page.

**`ssh -R` through a VPS you already have:**

```sh
ssh -N -R 0.0.0.0:2222:127.0.0.1:2222 you@your.vps
```

Players run `ssh -p 2222 first-fight@your.vps`. The VPS's sshd binds remote forwards to its loopback only, unless its `/etc/ssh/sshd_config` has `GatewayPorts clientspecified` (or `yes`). Set that, reload sshd, and open TCP 2222 in the VPS firewall. Your tunnel ends when this ssh does. Add `-o ServerAliveInterval=30` so it notices a dead link.

**Not cloudflared.** A Cloudflare quick tunnel carries only HTTP. A named tunnel can carry SSH, but every player then needs `cloudflared` installed and set up as an ssh `ProxyCommand`. That breaks "nothing to install".

Through a tunnel every player arrives from the tunnel's address. The host limits connections per address (8 at once), so a tunnelled table holds about 6 players with a couple of one-off commands in flight, and they share one address's rate of new sessions (20, then 1 a second).

## 3. The relay on a small VPS

The relay gives your table a permanent address, `ssh <handle>/<table>@table.example.com`. You don't open a port at home, and your machine can be anywhere. Your host dials out to the relay. The relay takes players' SSH connections and passes each one down that link to your machine. Your machine still renders every screen and keeps the log.

One relay serves any number of GMs and tables. Each GM has a handle, held by their GM key (`~/.config/supervillain/gm_key`, or under `$XDG_CONFIG_HOME`), so one GM's tables share one name (`ana/first-fight`, `ana/the-keep`), and two GMs can each have a `den`.

**What the relay sees, and what it can do.** Players' SSH ends at the relay, and the relay passes their sessions to your machine over its own link. So the relay sees every keystroke and every frame of play in the clear, though it keeps none of it. And it vouches for every player it brings: your host takes the relay's word for which key each relayed player holds, and the relay makes up guests too. A relay you've pinned can't be spoofed by anyone else, but whoever runs it, or breaks into it, can read your table and seat anyone as anyone at every table linked to it. Run your own relay, or use one run by someone you trust as much as your players. (A relay that only forwarded TCP, as `ssh -J` does, would keep players' SSH end to end with your machine. That's not built yet.)

**Trying it on one machine.** The relay and the host both default to port 2222, so run the host with `--port 2300` (or the relay with `--player-port`), and point the host at `--relay 127.0.0.1`. If you joined a table directly on `127.0.0.1:2222` before, players' ssh will warn that the key there changed: it's the relay's now.

### A VPS and a name

Any small Linux VPS works: 1 vCPU and 512 MB is plenty, x64 or arm64. Point a DNS name at it with an A record (and an AAAA record if it has IPv6):

```
table.example.com.  300  IN  A  203.0.113.10
```

### Install and run it as a service

On the VPS, install the binary as in [Install](#install) above. Then give the relay a user of its own and a service:

```sh
sudo useradd --system --home-dir /var/lib/supervillain-relay --shell /usr/sbin/nologin supervillain
sudo tee /etc/systemd/system/supervillain-relay.service >/dev/null <<'EOF'
[Unit]
Description=supervillain relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/supervillain relay --dir /var/lib/supervillain-relay --bind 0.0.0.0 --player-port 2222 --gm-port 7022
User=supervillain
Group=supervillain
StateDirectory=supervillain-relay
StateDirectoryMode=0700
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
# No capabilities at all (on port 22, CAP_NET_BIND_SERVICE: see below).
CapabilityBoundingSet=
# Every player's session is a socket, and every GM's link one more.
LimitNOFILE=8192
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now supervillain-relay
journalctl -u supervillain-relay -n 20
```

A relay GMs dial at an address other than `supervillain.sh:7022` should say so with `--public-relay host:port`, so the lobby's Create a Table command carries `--relay host:port` for them.

When it starts, the relay prints where to reach it and its two keys:

```
supervillain relay: keeping its keys and handles in /var/lib/supervillain-relay
players join with: ssh -p 2222 <handle>/<table>@<this host>
GMs dial 0.0.0.0:7022 (supervillain host --handle <you> --relay <this host>:7022)
relay key SHA256:qvkXv/0oq8giV0/7z4dtuBdvLT5onmKPQztKIMFOEtQ
  GMs pin it with: --relay-key SHA256:qvkXv/0oq8giV0/7z4dtuBdvLT5onmKPQztKIMFOEtQ
host key SHA256:eaIkljiTdK8kbQz3HpTcvu1vxAfazjOz5/vcRD4fDWA (what players' ssh sees)
a handle's claim lapses after 180 days with no GM linked
```

The relay key is what GMs' hosts pin. The host key is what players' ssh shows them the first time. `/var/lib/supervillain-relay` holds both keys (`relay_key`, `host_key`) and `handles.json`, and nothing else: the relay keeps no logs of play and renders nothing. Back the folder up. If the keys are lost, every GM's host and every player's ssh will see a new relay. Without `--dir`, the relay keeps its files in `~/.supervillain-relay`.

The relay limits each player address to 8 connections and 8 sessions, with a rate on new connections and sessions; each table to 32 players' sessions at once (`ana/first-fight is full right now.`); each GM address to 8 links; and the GMs linked at once to 256. An IPv6 address counts by its /64, which one person usually holds whole. A player over a connection limit sees `Connection reset by peer`, and the journal says `refused a connection from <address>: …` (a few times a minute at most for one address); over a session limit, ssh says `channel 0: open failed`.

The relay refuses to start if group or others can write to its folder, since whoever can write `handles.json` can take any handle: `chmod 700` it. A relay upgraded from protocol 1 renames its old `rooms.json` to `rooms.json.legacy` on start and says so; GMs claim handles afresh.

### Firewall

Open the player port and the GM port, and keep your own SSH open before you enable the firewall:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 2222/tcp     # players
sudo ufw allow 7022/tcp     # GMs' hosts dialing in
sudo ufw enable
```

Open the same ports in your provider's firewall too, if it has one.

To let players type `ssh <handle>/<table>@table.example.com` without `-p`, the player port must be 22. That means first moving the VPS's own sshd to another port (and allowing that port), then running the relay with `--player-port 22`, and in the unit `AmbientCapabilities=CAP_NET_BIND_SERVICE` with `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`. A host assumes port 22 for the join command it shows; GMs on a relay that stays on 2222 pass `--relay-player-port 2222`. Leave the relay on 2222 until you're sure of the rest. On port 22, someone who types a bare `ssh table.example.com` arrives with their own username, and scanners try `root` and the like all day: the relay keeps names like those (`root`, `admin`, `ubuntu`, `pi`, `git`, `lobby`, `help` and others) from ever being a handle or a shorthand, and answers them with [the lobby](#the-lobby), or with how to join when they bring no terminal to draw it in.

### Pin the relay's key

The relay has its own key, which it presents to GMs' hosts. Its fingerprint is in the journal when it starts (`relay key SHA256:…`). A host trusts players' identities only from a relay with that key, so a spoofed relay can't seat anyone as anyone. The relay you pin can: see [what the relay sees](#3-the-relay-on-a-small-vps).

```sh
supervillain host ~/campaigns/first-fight --handle ana --table first-fight \
  --relay table.example.com --relay-key SHA256:<the relay's key fingerprint>
```

`--relay` takes `host:port`, and the port defaults to 7022. With `--relay-key`, the host trusts only that key. Without it, the first link stores the relay's key in `<campaign>/relay_known`, and later links must match it. A link with `--relay-key` stores that key there too, if there's none yet, so a later start without the flag stays pinned. Your band then says `relay key SHA256:… trusted on first use`, and `host.log` says the same, so compare it with the journal. Pass `--relay-key` whenever you can.

A relay that shows a different key is refused, loudly: your band says `relay refused: its key … doesn't match …`, and the host stops dialing it. If the relay's key really changed (its folder was lost), check the new fingerprint with whoever runs it, put it in `relay_known` (or pass the new `--relay-key`), and the host links again within a few seconds. `relay_known` takes one fingerprint a line, and `#` starts a comment: a relay that is moving to a new key can tell its GMs ahead, and a host with both lines links with either.

While the link isn't up, the header at the top of your seat says so beside the table's name, whatever else is on screen: `relay: connecting…`, `relay: down, redialing`, `relay: refused, redialing`, or `relay: refused, see host.log`. The band below it says more while you sit alone: `players join with: ssh ana/first-fight@table.example.com` once it's up, `relay: connecting…` with the last error while it isn't, and `relay refused: …` if the relay turned the table down (saying why: `this address claims handles too fast`, `the relay holds its most handles`, `the handle ana has 8 tables open already`, `the relay has its most GMs linked`, or `this relay speaks protocol 2 …` to a host that needs upgrading) or its key was wrong. A refused host redials with the same backoff. If the link drops, the host redials on its own, waiting 1 second, then 2, 4 and so on up to 30; the wait starts over once a link has held for a second. If a link drops within a second of login, the band says `relay: connecting… (the link dropped within a second of login; if it keeps on, the relay's log says why)`: a relay that lets the host in and then can't give it the handle does this, so ask whoever runs it. The join command assumes the relay's player port is 22; if it isn't, tell the host with `--relay-player-port`.

The host still listens on `--port` and `--bind` as before, so local players can connect directly while remote ones come through the relay; direct players still see the campaign's own `host_key`, and the relay sees your GM key. Handles are 1 to 24 characters of `a-z`, `0-9` and `-`, starting with a letter, and not one of the names the relay keeps (`root`, `admin`, `ubuntu`, `pi`, `git`, `lobby`, `help` and the like); table names are the same, 1 to 32 long. The host says which doesn't fit; pass `--table` if your folder's name doesn't.

Players run `ssh ana/first-fight@table.example.com` (or `ana.first-fight`), and knock the first time. Once you've let them in, `ssh first-fight@table.example.com` is enough: the relay asks only the open tables called `first-fight`, and seats a player at the one that knows their key. The first time, ssh shows them the relay's host key, not your table's, so give them the relay's fingerprint (`host key SHA256:… (what players' ssh sees)` in its journal). Pass it to your host with `--relay-host-key` and it's printed with the join command, in your `/help` and in `host.log`; without it, the host says to ask whoever runs the relay. Your table's own host key is for players who connect directly, and all three say so. If your machine is off, they're told `ana/first-fight isn't open right now.`, in [the lobby](#the-lobby) when they have a terminal, where they can type the right name. If your host stops or its link drops while they're seated, they're told `The GM closed the table.` or `The table closed.`, and can connect again once your host is back.

### The lobby

A player who connects to the relay without naming an open table (`ssh lobby@table.example.com`, or a bare `ssh` whose username names no table) gets the lobby: a centered stage under the supervillain title with a status bar, a `tables` column on the left, and selected-table details or `identity` + `commands` on the right. From it they sit down exactly as if they had typed the table's name before the `@`.

A returning player is shown the open tables that know their key, and picks one with the arrows or its number. For that, the relay asks every host linked now, over its link, whether it knows the player's key. Your host says yes only for a member: a key you let in, or one with an event in your log you haven't removed, or (with the door open) one seated now. It adds how many are seated. A stranger or someone still knocking is never listed. A host that doesn't answer within 2 seconds counts as no.

A first-timer or a guest is shown no list: a key no open table knows, and a guest, for whom the relay asks nobody, see how to sit down instead. They type the table's full name and press Enter. A returning player can type a name too, for a table that isn't on their list, and a bare table name picks it from their list. A name that isn't open is answered on the screen (`ana/first-fight isn't open right now.`, or `No open table called first-fight knows your key…`), and after five of those the relay prints the join hint and ends the session. So does a minute without a key pressed.

Without a terminal (a command, or `ssh -T`) there's no screen to draw: the relay prints the list with how to join, or the join hint when there's nothing to list.

What it reveals:

- To a player: the table's address and how many are seated, for tables that are open now and already know their key. A table that doesn't know them is never named, and the shorthand asks only tables of the name they typed. A name they type is answered as `ssh <handle>/<table>@` answers it (open or not), five names to a session.
- To every linked host: that someone looked, and when. The relay never sends the key: it sends a fresh random nonce and a MAC of the key under it, which a host can only check against keys it already has. Your host checks the keys in its log, so it learns which of its own players looked (`lobby: the relay listed this table for key:SHA256:…` in `host.log`) and nothing about anyone else. A host changed to check a list of public keys gathered elsewhere (GitHub publishes everyone's) could tell whether one of those looked.
- To the relay: which tables know which keys. It already sees every player's key and table as it seats them.

So a player you've let in learns your table is open, and its name if you changed it; `/kick` takes them off. To keep your table off the list, start the host with `--no-lobby`: it then answers every question no, and players must type the table's full name. The host says which it is when it starts (`its lobby lists this table …` or `its lobby never lists this table`). A host from before the lobby refuses the question, which the relay takes as no.

Without a relay, the username doesn't matter: a host serves one table, so `ssh -p 2222 table.example.com` with any name sits down at it.

### Handles

A handle is the relay's record that a name belongs to one GM's keys. The first host to link a table under a handle claims it with its GM key, and the relay writes the claim to `handles.json`: the keys that hold it, when it was claimed, and when a table under it was last seen.

```json
{
  "ana": {
    "keys": ["SHA256:WwzfvSCl3H6phF79dwAJgz3vuWlNTCJptC8mHSKc24I"],
    "claimed": "2026-10-21T19:04:11.000Z",
    "seen": "2026-11-21T22:40:02.000Z"
  }
}
```

After that, the relay refuses that handle to any other key, so nobody else can open a table under your name. A refused host keeps redialing, and its band shows `relay: connecting… (the link closed before the relay logged in; if this keeps up, another GM's key may hold the handle ana there …)`. The relay's journal names the key it refused. One handle opens 8 tables at once.

Your GM key lives on one machine. To host from another, you need a claim code, which the relay mints only for a key that already holds the handle: an `sv-` code good once, for 15 minutes. Start the other machine's host with `--claim sv-…` and the relay adds its GM key to the handle (4 keys at most). The code never crosses the wire: the host sends an HMAC-SHA256 of its own GM key's fingerprint keyed by the code, so someone watching the link can't use what they see with another key. The code is spent only once the key is added, so a handle that already holds 4 keys refuses the claim and leaves the code good. A key holds 3 live codes at most, and an address that guesses wrong codes is slowed.

The relay renews a handle's time whenever one of its tables links and again when the link ends, so a handle in use never lapses. A handle with no table seen for 180 days lapses (30 days if it never linked a table at all): the next key to link under it claims it, and the journal says `handle ana: dropped the claim of GM keys SHA256:…, last seen …`. Change the 180 with `--claim-days` on `supervillain relay`.

A GM who loses every machine's `gm_key` needs the handle released. On the VPS:

```sh
sudo -u supervillain supervillain relay forget ana --dir /var/lib/supervillain-relay
```

Run it as the relay's user, so `handles.json` stays the relay's to read. The next GM to link a table under `ana` claims it; tables linked now stay open until they drop. A running relay picks this up without a restart.

Claiming a handle costs nothing but a link, so someone could claim a name you're likely to use before you do. If a handle you want is taken, pick another with `--handle`, or ask whoever runs the relay. To slow squatting, one address claims 3 new handles, then one an hour. Only a claim made counts: a link whose login fails (a GM's host that doesn't trust the relay's key yet, say) costs nothing. An IPv6 address counts by its /64, and each /48 also claims at most 10, then 4 an hour, however many /64s it uses. Linking another table under a handle you hold claims nothing. A refused claim shows in the journal as `handle ana: refused: 203.0.113.7 claims handles too fast`.

The relay holds at most 4096 handles. A new claim first drops every lapsed handle, and the journal says which, ending `to make room for <handle>`. A handle that hasn't lapsed is never dropped to make room: if the relay still holds 4096, the new one is refused with `handle ana: refused: the relay holds its most handles (4096), none lapsed`, and the GM is told `the relay holds its most handles; try again later`.

### Upgrading

Download the new release and check it as in [Install](#install), then on the relay:

```sh
sudo install -m 0755 supervillain-linux-x64 /usr/local/bin/supervillain
sudo systemctl restart supervillain-relay
```

GMs' hosts redial on their own. Seated players get their terminal back, are told `The relay is shutting down.`, and connect again. On your own machine, stop the host, replace the binary the same way and start it again. The campaign folder stays as it is. Upgrade the relay and the hosts that use it to the same release.

#### Automated deploys from GitHub Actions

`.github/workflows/release.yml` calls `.github/workflows/relay-deploy.yml` after every non-prerelease `v*` release (and `relay-deploy.yml` can also be run manually from the Actions tab to deploy or roll back to any tag). The workflow downloads the attested binary from the release, verifies both `SHA256SUMS` and `gh attestation verify`, and streams a tar archive over SSH to a restricted forced-command script on the VPS. The VPS never needs a GitHub token, and the deploy key cannot open a shell or read `/var/lib/supervillain-relay`.

One-time VPS setup:

1. Install `scripts/deploy-relay.sh` as root:

   ```sh
   sudo install -m 0755 -o root -g root scripts/deploy-relay.sh /usr/local/sbin/deploy-supervillain-relay
   ```

2. Generate a dedicated deploy keypair, create a locked `deploy` user, and restrict its key to that single script:

   ```sh
   ssh-keygen -t ed25519 -N "" -C "supervillain-relay-deploy" -f /tmp/relay_deploy_key
   sudo useradd --system --create-home --shell /bin/sh deploy
   sudo install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
   printf 'restrict,command="sudo -n /usr/bin/env bash /usr/local/sbin/deploy-supervillain-relay" %s\n' "$(cat /tmp/relay_deploy_key.pub)" \
     | sudo tee /home/deploy/.ssh/authorized_keys >/dev/null
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
   sudo chmod 0600 /home/deploy/.ssh/authorized_keys
   ```

   If your `/etc/ssh/sshd_config` sets `AllowUsers`, add `deploy` to it and reload `sshd`.

3. Allow `deploy` to run only that script via `sudo`:

   ```sh
   echo 'deploy ALL=(root) NOPASSWD: /usr/bin/env bash /usr/local/sbin/deploy-supervillain-relay' \
     | sudo tee /etc/sudoers.d/supervillain-relay-deploy >/dev/null
   sudo chmod 0440 /etc/sudoers.d/supervillain-relay-deploy
   sudo visudo -cf /etc/sudoers.d/supervillain-relay-deploy
   ```

4. In GitHub → Settings → Environments, create an environment named `relay` (optionally enable Required reviewers if you ever want a manual approval pause before restarting the live relay) and set:

   - **Secrets**:
     - `RELAY_SSH_HOST`: the VPS hostname or IP
     - `RELAY_SSH_KEY`: the private key from `/tmp/relay_deploy_key` (delete `/tmp/relay_deploy_key*` once saved)
     - `RELAY_SSH_KNOWN_HOSTS`: output of `ssh-keyscan -p <sshd-port> <vps-host>`
   - **Variables** (optional):
     - `RELAY_SSH_PORT`: your VPS's sshd port (defaults to `22`)
     - `RELAY_SSH_USER`: defaults to `deploy`
     - `RELAY_ARCH`: `linux-x64` (default) or `linux-arm64`

When a deploy runs, `/usr/local/sbin/deploy-supervillain-relay` verifies the archive, checksum, and `--version`, swaps `/usr/local/bin/supervillain` atomically, restarts `supervillain-relay`, and automatically rolls back to the previous binary if the service fails to stay active.
