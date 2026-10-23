# Hosting a supervillain table

Your machine is the table. `supervillain host` runs an SSH server on it, keeps the campaign log in your campaign folder and gives you the GM's seat in the terminal you started it from. Players need only `ssh`; send them [PLAYING.md](PLAYING.md).

This page covers installing the binary, starting a table, and the three ways players can reach it:

1. the same network or a Tailscale tailnet;
2. a tunnel (bore, or `ssh -R` through a server you rent);
3. the relay, on a small VPS of your own.

## Install

There is no release of the rebuild yet: build the binary yourself (below) or run from source (`bun install`, then `bun supervillain …` from the repo root). The releases on GitHub up to v0.2.0 are the archived build and don't have these files. Once a release is tagged, it has one self-contained executable per platform, plus `SHA256SUMS`:

| File | For |
| --- | --- |
| `supervillain-linux-x64` | Linux on Intel or AMD (glibc) |
| `supervillain-linux-arm64` | Linux on ARM (glibc), e.g. a Raspberry Pi 4 or 5 on a 64-bit OS, or an ARM VPS |
| `supervillain-darwin-arm64` | macOS on Apple silicon |
| `supervillain-darwin-x64` | macOS on Intel |

The repository is private for now, so download with the GitHub CLI while signed in:

```sh
gh release download <tag> -R oscabriel/supervillain -p supervillain-linux-x64 -p SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS      # macOS: shasum -a 256 --ignore-missing -c SHA256SUMS
sudo install -m 0755 supervillain-linux-x64 /usr/local/bin/supervillain
supervillain --version
```

Replace `<tag>` with the release you want (`gh release list -R oscabriel/supervillain`), and the file name with your platform's. Downloading with `gh` or `curl` is fine on macOS. If you download with a browser, macOS quarantines the file and won't open it. Clear that with `xattr -d com.apple.quarantine supervillain-darwin-arm64`.

To build it yourself from a checkout, run `bun install`, then `bun run release:build`. That writes `dist/supervillain-<os>-<arch>` for your machine. Use `--all` for every platform after `bun install --os="*" --cpu="*"`.

## Start a table

```sh
supervillain new ~/campaigns/first-fight --example
supervillain host ~/campaigns/first-fight
```

`new --example` copies the sample campaign: four heroes, the bandits and the map for one fight. Without `--example` you get a `campaign.yaml` and empty `heroes/`, `monsters/` and `maps/` folders (only `maps/` with `--rules set-world`). The folder's README explains the file formats. `host` opens a campaign folder and refuses one that isn't there (`there's no campaign at …; make one with: supervillain new …`), and a folder with none of `campaign.yaml`, `events.jsonl`, `host_key`, `heroes/`, `monsters/` or `maps/` in it (`… isn't a campaign: …`), so a mistyped path never starts an empty table under a new host key, and your home folder never gets a log.

`supervillain map crossing <campaign> --seed 7` (or `keep`) generates a map into `maps/` and says how to load it, and at the table `/map new crossing 7` does the same and loads it (see [Preparing a game](#preparing-a-game)); the campaign README has how maps work.

### What the campaign plays

A campaign plays one ruleset, named in `campaign.yaml` at its root: `rules: draw-steel` or `rules: set-world`. `new` writes it (`draw-steel` unless you pass `--rules set-world`), and a campaign without one plays Draw Steel. The host reads it when it starts and refuses a ruleset it doesn't know, or any other setting, naming the file: `…/campaign.yaml: says rules: pathfinder, but a campaign plays draw-steel or set-world`. The ruleset decides which commands the table offers (`/help` and Tab show only those) and what the band, the map and `/sheet` show. Chat, names, dice and `/undo` are the same at either table. `--example` makes only a Draw Steel campaign, since that's what the sample is.

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
| `/unplay ada` | Free a party member a player holds |

The fight follows Set's turn-based rules (stamp `set-world-0-15-0-dungeon-initiative-2`): each fighter acts every `1000 / initiative` milliseconds of a logical clock, so there are no rounds, and an exact tie goes to the party first; everyone recovers 10 stamina a second of that clock; an attack costs 20 stamina, hit or miss; a hit is a dodge draw against `dodgeRate × (1 − clarity)`, a critical draw against `criticalHitChance` that doubles it, and `max(1, floor(raw × (1 − reduction) × (1 − globalResistance)))`. Set's own fights have no positions, so the grid's rules are the table's: speed is `round(5 × walkSpeed)` squares a turn; a weapon reaches by how it delivers (melee 1 square, 2 past 40 inches of reach; projectiles 10; waves 5 and auras 3, which hit as magic, with `magicalDamage` against `magicalDamageReduction`), checked only when both fighters are on the map. When the last of one side falls the fight is over; stamina then refills and health stays as it is. Expect long fights: hits of 7 to 19 against 150 to 230 health.

`host` prints what to send your players:

```
supervillain: hosting "first-fight" from /home/you/campaigns/first-fight, playing draw-steel
players join with: ssh -p 2222 first-fight@127.0.0.1
host key SHA256:gkYn722z8+JIXdkwJa/9amF10Y2+zkGdElyWlj0LZHk
```

Send players the join command, with your address in place of `127.0.0.1` (see below), and the host key. When ssh first connects it shows them that fingerprint, and comparing the two is how they know they reached you. Your seat covers that output once it opens, so while you sit alone its band shows `players join with: ssh -p 2222 first-fight@127.0.0.1 · host key SHA256:…`, and the end of `/help` and `host.log` have both too. Ctrl-C at your seat closes the table. While players are seated it asks you to press it again.

If the port is taken, by another table say, `host` says so and stops: `port 2222 on 127.0.0.1 is in use (another table?); pick another with --port, or --port 0 for any free one`.

| Option | What it does |
| --- | --- |
| `--port 2222` | The port players connect to. `0` picks a free one |
| `--bind 127.0.0.1` | The address to listen on. The default lets in only this machine and tunnels running on it; `0.0.0.0` listens on every network |
| `--room <name>` | The room's name, which players type before the `@`. It defaults to the campaign folder's name |
| `--headless` | Runs without the GM's seat, with logs on stdout. Nobody has GM powers, so this is for trying a server, not for running a game |
| `--relay host[:7022]` | Also take players through a relay; see [3. The relay](#3-the-relay-on-a-small-vps) |
| `--relay-key SHA256:…` | The relay key to trust, instead of the one in `relay_known` |
| `--relay-player-port 2222` | The relay's player port, for the join command you're shown |
| `--relay-host-key SHA256:…` | The relay's host key, shown with that join command so you can pass it on to players |
| `--no-lobby` | Keeps the table off the relay's lobby; see [The lobby](#the-lobby) |

The campaign folder is yours alone (mode 700). Beside `campaign.yaml` and what you put in it, the host writes these files into it:

- `events.jsonl`: the log, one event per line. It holds every word said at the table.
- `host_key`: the table's SSH identity. Keep it, or players' ssh will warn that the key changed.
- `events.lock`: while a host runs, so only one host at a time writes to a campaign.
- `host.log`: what the host did, when you have the GM's seat.
- `relay_known`: the relay key this campaign trusts, written on the first link to a relay (the `--relay-key`, if you passed one).

The host refuses a `host_key` other users can read (`chmod 600` it). Players are capped so one stranger can't take the table down: 8 connections and 16 sessions from one address, 64 of each in all, 20 seconds to log in, and a few lines a second per player.

`supervillain check ~/campaigns/first-fight` reads a log without opening the table: a summary, skipped events, the feed and the final state.

## Preparing a game

At your seat, Alt+5 or `/prep` opens the prep panel, under the feed. It is the GM's alone: a player's Alt+5 or `/prep` is told so. Each time it opens it reads `heroes/`, `monsters/` and `maps/` again, so a sheet you saved a minute ago is there, and a file that won't load is listed by its id (loading it says why). Every item shows, dim, the command a click sends: the very line you could type, so the log can't tell a click from typing, and Up brings back what a click sent. Nothing in the panel changes the table by itself, and you can go on typing commands as before.

| Section | What a click does |
| --- | --- |
| Heroes (Draw Steel) | Brings a hero into the party: `/hero brann`. One already in it is marked `in play`, and clicking it reloads its sheet |
| Monsters (Draw Steel) | Opens a count under the section: − and + set it, Add sends `/add bandit-chief` (one) or `/add bandit-chief x3`, Cancel or Esc closes it |
| Fighters (set.world) | Recruit or Foe puts `/recruit ` or `/foe ` on the input line: type the name and, if you like, a seed, then Enter |
| Maps | Loads one: `/map ford-road`, marked `loaded` once it is. Put away sends `/map off`. New crossing and New keep generate one (`/map new keep`), and New, by seed puts `/map new ` on the input line for a kind and a seed |
| Place | Lists whoever isn't on the loaded map yet. Click one, then a square on the map: `/place bandit-chief p5` |
| Start | `/start`; while the fight is on it says so instead |

The panel takes rows under the feed: what its sections need, up to half of what the band and the map would have (a third once a map shows), and the wheel scrolls the rest. It always leaves the band its living rows and the map enough to click a square, so in a big fight at 80x24 it may be down to one line, and it steps aside while a Place waits for its square. Otherwise at 80x24 that's three to six lines. Alt+5 or a click on its title hides it again; hidden, the hint row offers `⁵ prep` to click.

`/map new crossing|keep [seed]` makes a map at the table the way `supervillain map` does, through the same code: it writes `maps/<kind>-<seed>.txt`, picking a seed when you leave it out, then loads it as `/map <id>` would. The event carries the grid, as every `/map` does, so replay never generates or reads the file. The seed is in the map's id, and a kind and seed always make the same map; one whose file is already in `maps/` (in any letter case) is refused with the `/map` that loads it. A map you generate shows in the panel's Maps at once, marked `loaded`.

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

Through a tunnel every player arrives from the tunnel's address. The host limits connections per address (8 at once), so a tunnelled table holds about 6 players with a couple of one-off commands in flight.

## 3. The relay on a small VPS

The relay gives your table a permanent address, `ssh -p 2222 <room>@table.example.com`. You don't open a port at home, and your machine can be anywhere. Your host dials out to the relay. The relay takes players' SSH connections and passes each one down that link to your machine. Your machine still renders every screen and keeps the log.

One relay serves any number of rooms. Each room is held by the GM host key that first linked it.

**What the relay sees, and what it can do.** Players' SSH ends at the relay, and the relay passes their sessions to your machine over its own link. So the relay sees every keystroke and every frame of play in the clear, though it keeps none of it. And it vouches for every player it brings: your host takes the relay's word for which key each relayed player holds, and the relay makes up guests too. A relay you've pinned can't be spoofed by anyone else, but whoever runs it, or breaks into it, can read your table and seat anyone as anyone at every room linked to it. Run your own relay, or use one run by someone you trust as much as your players. (A relay that only forwarded TCP, as `ssh -J` does, would keep players' SSH end to end with your machine. That's not built yet.)

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

When it starts, the relay prints where to reach it and its two keys:

```
supervillain relay: keeping its keys and rooms in /var/lib/supervillain-relay
players join with: ssh -p 2222 <room>@<this host>
GMs dial 0.0.0.0:7022 (supervillain host --relay <this host>:7022)
relay key SHA256:qvkXv/0oq8giV0/7z4dtuBdvLT5onmKPQztKIMFOEtQ
  GMs pin it with: --relay-key SHA256:qvkXv/0oq8giV0/7z4dtuBdvLT5onmKPQztKIMFOEtQ
host key SHA256:eaIkljiTdK8kbQz3HpTcvu1vxAfazjOz5/vcRD4fDWA (what players' ssh sees)
a room's claim lapses after 180 days with no GM linked
```

The relay key is what GMs' hosts pin. The host key is what players' ssh shows them the first time. `/var/lib/supervillain-relay` holds both keys (`relay_key`, `host_key`) and `rooms.json`, and nothing else: the relay keeps no logs of play and renders nothing. Back the folder up. If the keys are lost, every GM's host and every player's ssh will see a new relay. Without `--dir`, the relay keeps its files in `~/.supervillain-relay`.

The relay limits each player address to 8 connections and 8 sessions, with a rate on new connections and sessions; each room to 32 players' sessions at once (`The table first-fight is full right now.`); each GM address to 8 links; and the GMs linked at once to 256. An IPv6 address counts by its /64, which one person usually holds whole. A player over a limit sees `Connection reset by peer`, and the journal says `refused a connection from <address>: …` (a few times a minute at most for one address).

The relay refuses to start if group or others can write to its folder, since whoever can write `rooms.json` can take any room: `chmod 700` it.

### Firewall

Open the player port and the GM port, and keep your own SSH open before you enable the firewall:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 2222/tcp     # players
sudo ufw allow 7022/tcp     # GMs' hosts dialing in
sudo ufw enable
```

Open the same ports in your provider's firewall too, if it has one.

To let players type `ssh <room>@table.example.com` without `-p`, the player port must be 22. That means first moving the VPS's own sshd to another port (and allowing that port), then running the relay with `--player-port 22`, and in the unit `AmbientCapabilities=CAP_NET_BIND_SERVICE` with `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`. GMs then pass `--relay-player-port 22` to their hosts, so the join command they're shown has no `-p`. Leave it on 2222 until you're sure of the rest. On port 22, someone who types a bare `ssh table.example.com` arrives with their own username, and scanners try `root` and the like all day: the relay keeps names like those (`root`, `admin`, `ubuntu`, `pi`, `git`, `lobby`, `help` and others) from ever being a room, and answers them with how to join instead, or with [the lobby](#the-lobby) for a key an open table knows.

### Pin the relay's key

The relay has its own key, which it presents to GMs' hosts. Its fingerprint is in the journal when it starts (`relay key SHA256:…`). A host trusts players' identities only from a relay with that key, so a spoofed relay can't seat anyone as anyone. The relay you pin can: see [what the relay sees](#3-the-relay-on-a-small-vps).

```sh
supervillain host ~/campaigns/first-fight --room first-fight \
  --relay table.example.com --relay-key SHA256:<the relay's key fingerprint>
```

`--relay` takes `host:port`, and the port defaults to 7022. With `--relay-key`, the host trusts only that key. Without it, the first link stores the relay's key in `<campaign>/relay_known`, and later links must match it. A link with `--relay-key` stores that key there too, if there's none yet, so a later start without the flag stays pinned. Your band then says `relay key SHA256:… trusted on first use`, and `host.log` says the same, so compare it with the journal. Pass `--relay-key` whenever you can.

A relay that shows a different key is refused, loudly: your band says `relay refused: its key … doesn't match …`, and the host stops dialing it. If the relay's key really changed (its folder was lost), check the new fingerprint with whoever runs it, put it in `relay_known` (or pass the new `--relay-key`), and the host links again within a few seconds. `relay_known` takes one fingerprint a line, and `#` starts a comment: a relay that is moving to a new key can tell its GMs ahead, and a host with both lines links with either.

While the link isn't up, the header at the top of your seat says so beside the room, whatever else is on screen: `relay: connecting…`, `relay: down, redialing`, `relay: refused, redialing`, or `relay: refused, see host.log`. The band below it says more while you sit alone: `players join with: ssh -p 2222 first-fight@table.example.com` once it's up, `relay: connecting…` with the last error while it isn't, and `relay refused: …` if the relay turned the room down (saying why: `this address claims rooms too fast`, `the relay holds its most rooms`, `the relay has its most GMs linked`) or its key was wrong. A refused host redials with the same backoff. If the link drops, the host redials on its own, waiting 1 second, then 2, 4 and so on up to 30. The join command assumes the relay's player port is 2222; if it isn't, tell the host with `--relay-player-port`.

The host still listens on `--port` and `--bind` as before, so local players can connect directly while remote ones come through the relay. Room names on a relay are 1 to 32 characters of `a-z`, `0-9` and `-`, starting with a letter, and not one of the names the relay keeps (`root`, `admin`, `ubuntu`, `pi`, `git`, `lobby`, `help` and the like; the host says so). Pass `--room` if your folder's name doesn't fit.

Players run `ssh -p 2222 first-fight@table.example.com`. The first time, ssh shows them the relay's host key, not your table's, so give them the relay's fingerprint (`host key SHA256:… (what players' ssh sees)` in its journal). Pass it to your host with `--relay-host-key` and it's printed with the join command, in your `/help` and in `host.log`; without it, the host says to ask whoever runs the relay. Your table's own host key is for players who connect directly, and all three say so. If your machine is off, they're told `The table first-fight isn't open right now.` A room nobody has linked is `There's no table called first-fight here.` If your host stops or its link drops while they're seated, they're told `The GM closed the table.` or `The table closed.`, and can connect again once your host is back.

### The lobby

A player who connects to the relay with a key but no room (`ssh -p 2222 lobby@table.example.com`, or a bare `ssh` whose username names no table) is shown the open tables that know their key, and picks one. They then sit down exactly as if they had typed its room. For that, the relay asks every host linked now, over its link, whether it knows the player's key. Your host says yes if the key has an event in your log (it has sat at your table and done something there) or has a seat open now, and adds how many are seated. A host that doesn't answer within 2 seconds counts as no. Guests are never shown a list, and neither is a key no open table knows: they get the usual join hint.

What it reveals:

- To a player: the room name and how many are seated, for tables that are open now and already know their key. A table that doesn't know them is never named.
- To every linked host: that someone looked, and when. The relay never sends the key: it sends a fresh random nonce and a MAC of the key under it, which a host can only check against keys it already has. Your host checks the keys in its log, so it learns which of its own players looked (`lobby: the relay listed this table for key:SHA256:…` in `host.log`) and nothing about anyone else. A host changed to check a list of public keys gathered elsewhere (GitHub publishes everyone's) could tell whether one of those looked.
- To the relay: which tables know which keys. It already sees every player's key and room as it seats them.

So a player you'd rather not see again learns your table is open, and its room name if you changed it. To keep your table off the list, start the host with `--no-lobby`: it then answers every question no, and players must type the room's name. The host says which it is when it starts (`its lobby lists this table …` or `its lobby never lists this table`). A host from before the lobby refuses the question, which the relay takes as no.

Without a relay, the username doesn't matter: a host serves one table, so `ssh -p 2222 table.example.com` with any name sits down at it.

### Room claims

A claim is the relay's record that a room belongs to one GM's host key (the campaign's `host_key`). The first host to link a room claims it, and the relay writes the claim to `rooms.json`: the room, the host key's fingerprint and when a GM was last linked to it.

```json
{
  "first-fight": {
    "key": "SHA256:WwzfvSCl3H6phF79dwAJgz3vuWlNTCJptC8mHSKc24I",
    "linked": "2026-10-21T19:04:11.000Z"
  }
}
```

After that, the relay refuses that room to any other host key, so nobody else can take your room while you're away. A refused host keeps redialing, and its band shows `relay: connecting… (the link closed before the relay logged in; if this keeps up, another GM's host key may hold room first-fight there)`. The relay's journal names the host key it refused.

The relay renews a claim's time whenever its GM links and again when the link ends, so a room in use never lapses. A claim no GM has linked for 180 days lapses: the next host key to link the room claims it, and the journal says `room first-fight: dropped the claim of GM host key SHA256:…, last linked …`. The 180 is long enough that a group meeting monthly, or taking a season off, keeps its room's name; change it with `--claim-days` on `supervillain relay`. A GM who comes back with the same host key after the claim has lapsed keeps the room, unless someone else claimed it first.

A GM who moves to a new machine without copying the campaign folder, or who loses `host_key`, needs the claim released sooner. On the VPS:

```sh
sudo -u supervillain supervillain relay forget first-fight --dir /var/lib/supervillain-relay
```

Run it as the relay's user, so `rooms.json` stays the relay's to read.

The next host to link `first-fight` claims it, and replaces the host linked now, if there is one. A running relay picks this up without a restart.

Claiming a room costs nothing but a link, so someone could claim a name you're likely to use before you do; the room's name defaults to your campaign folder's. If a room you want is taken, pick another with `--room`, or ask whoever runs the relay. To slow squatting, one address claims 3 new rooms, then one an hour. Only a claim made counts: a link whose login fails (a GM's host that doesn't trust the relay's key yet, say) costs nothing. An IPv6 address counts by its /64, and each /48 also claims at most 10, then 4 an hour, however many /64s it uses. Relinking a room you hold claims nothing. A refused claim shows in the journal as `room first-fight: refused: 203.0.113.7 claims rooms too fast`.

The relay holds at most 1024 claims. When it's full, a new claim drops the claim whose GM linked longest ago, and the journal says which, ending `to make room for <room>`. A claim with a GM linked now is never dropped. If every claim has a GM linked, the new one is refused: `room first-fight: refused: the relay holds its most rooms (1024), each with a GM linked now`.

### Upgrading

Download the new release and check it as in [Install](#install), then on the relay:

```sh
sudo install -m 0755 supervillain-linux-x64 /usr/local/bin/supervillain
sudo systemctl restart supervillain-relay
```

GMs' hosts redial on their own. Seated players get their terminal back, are told `The relay is shutting down.`, and connect again. On your own machine, stop the host, replace the binary the same way and start it again. The campaign folder stays as it is. Upgrade the relay and the hosts that use it to the same release.
