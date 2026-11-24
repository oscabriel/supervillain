---
title: Why the relay runs on a five-dollar VPS
summary: This site runs on Cloudflare. The table's relay runs on a small Linux VPS. Players type a plain ssh command, and we checked every 2026 Cloudflare TCP option before making the call.
date: 2026-11-21
---

This site is a set of static pages deployed to Cloudflare with Alchemy. It would be tidy for the relay to live there too: one provider, a global edge, no Linux box to patch. Before deploying anything, we audited every TCP option Cloudflare ships today, including Inbound TCP Workers and Containers. The relay still runs on a five-dollar Linux VPS. Here is the engineering arithmetic so nobody has to redo it.

## What the relay has to do

A GM's machine is usually a laptop behind a home router. It can't accept inbound connections from the internet, and it shouldn't have to. So the GM's host dials out to the relay and holds one SSH link open, and the relay gives the table a permanent address:

```sh
ssh -p 2222 first-fight@table.example.com
```

That command is the entire product promise. A player pastes it into the OpenSSH client their operating system already ships, and they are seated. Five hard requirements fall straight out of it:

- **Two inbound raw TCP ports.** One public port for players' stock OpenSSH clients (22 or 2222) and a second port for GMs' hosts dialing out to link their rooms (7022). Not HTTP, not WebSockets.
- **SSH termination at the relay.** The relay holds a pinned host key players' `ssh` trusts, authenticates keys or guests, reads the room name from the SSH username, runs the lobby, and multiplexes sessions onto the GM's link.
- **Four-hour connections.** A tabletop session runs three to four hours with steady keystrokes one way and screen frames the other.
- **Stranger bounds per address.** Public SSH ports attract scanners within minutes. The relay caps connections and sessions per address (and per IPv6 /64), rate-limits new logins and room claims, and cuts peers that stop reading past 4 MiB or rekey repeatedly.
- **Tiny durable state.** Two SSH keys (`host_key`, `relay_key`) and `rooms.json`. Zero game logs, zero rendering.

## Checking Cloudflare's 2026 TCP stack

We evaluated all four ways Cloudflare touches raw TCP today. None of them beat a plain VPS for this workload:

**Inbound TCP Workers via Spectrum.** Cloudflare now supports routing inbound TCP from Spectrum into a Worker's `connect()` handler, which gets closer than outbound-only sockets did a couple of years ago. Two hard walls still block us: Spectrum TCP requires a paid Pro zone ($20/month before usage) and caps non-Enterprise zones at **one TCP port per zone**. Our relay needs two ports (players on 22/2222 and GMs on 7022). On top of that, `workerd` still does not run Node's `ssh2` server natively, and long-lived sockets through Workers and Durable Objects face eviction windows (~15 minutes of idle or platform recycling) that cut mid-combat sessions.

**Cloudflare Containers.** Containers can run our compiled Linux `supervillain` binary unmodified. That solves `ssh2`, but not the economics or ingress: an always-on SSH relay has to stay warm 24/7 so players and GMs connect immediately, which runs roughly $15 to $30/month in memory-second billing, and it still needs public raw TCP ingress in front of it.

**WebSockets into a Durable Object.** A Durable Object is a great fit for room coordination, and WebSocket hibernation is cheap. But OpenSSH does not speak WebSockets. Every player would need a local helper installed and wired up as an ssh `ProxyCommand`.

**Cloudflare Tunnel.** A quick tunnel carries only HTTP. A named tunnel can carry SSH, but every player has to install `cloudflared` and configure a `ProxyCommand`. That breaks "nothing to install".

None of this is a slight against Cloudflare. Its network is unmatched for HTTP, static assets, and edge compute. Our relay just sits right on the seam where raw multi-port TCP and multi-hour SSH sessions are still native Linux territory.

## What a five-dollar VPS buys

`supervillain relay` renders nothing and writes no game logs. It shuffles SSH bytes between sockets and enforces connection bounds. Text frames are about 1 KB per chat line, and kitty-graphics picture-map updates are 5 to 10 KB per move. A 1 vCPU, 512 MB Linux VPS ($5 to $6/month on Vultr or similar) handles dozens of simultaneous tables with headroom to spare:

- **Both ports, including port 22.** Move the VPS's own `sshd` to an admin port, give the relay `CAP_NET_BIND_SERVICE`, and players type `ssh first-fight@play.example.com` with no `-p` flag at all.
- **Four-hour sessions without eviction.** Kernel TCP sockets stay open as long as the game runs, with SSH keepalives catching dead home routers cleanly.
- **Tight blast radius.** One static binary, one unprivileged `supervillain` user, a 20-line systemd unit (`ProtectSystem=strict`, `NoNewPrivileges=yes`, `MemoryMax=512M`), and unattended security upgrades.
- **Clear trust boundary.** Because player SSH terminates at the relay, whoever operates the relay sees terminal bytes in transit and vouches for player keys. On a VPS you control, that operator is you.

## Split the job cleanly

We put each piece where it actually shines:

- **Cloudflare** serves this Foldkit site: prerendered HTML, instant global edge caching, deployed in seconds with `@alchemy.run/cloudflare`.
- **A five-dollar VPS** runs `supervillain relay`: raw multi-port TCP, post-quantum hybrid SSH (`mlkem768x25519-sha256`), and zero-install access for every player's built-in `ssh` client.

The [hosting guide](/docs/hosting) has the complete systemd unit, firewall rules, and relay-key pinning steps.
