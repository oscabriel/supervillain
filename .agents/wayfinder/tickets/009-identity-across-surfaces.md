---
status: closed
type: grilling
assignee: oscar
blocked-by: []
---

# Identity across surfaces

## Question

What is identity in supervillain, across all three surfaces? The old plan unified the terminal world on **ed25519 public keys**: a player's SSH key is their account (no signup), a GM/CLI identity is an iroh NodeId, guests enter keyless and can upgrade with progress adopted. The web surface breaks that elegance: read-only artifact pages need _some_ access story (public? capability URLs?), and the future browser terminal has no SSH key to offer. Sub-questions:

- Terminal: reaffirm key-as-account + guest path + adoption-on-upgrade?
- One human, several keys (laptop + desktop + CLI NodeId): is cross-device linking (`/invite` one-time codes) a launch need or later?
- Web read-only artifacts: public-by-link (capability URLs), or gated?
- Browser terminal identity — partially informed by [Browser terminal bridge](004-browser-terminal-bridge.md); decide only the posture now, details after that research lands.

## Resolution

All four parts accepted as recommended:

1. **Terminal: key-as-account reaffirmed wholesale** — SSH key fingerprint for players, iroh NodeId for GM/CLI, keyless guest path with can't-miss upgrade box, guest progress **adopted** on upgrade (prototype-validated).
2. **Read-only web artifacts: capability URLs** — the share link is the permission; unguessable slug, revocable by the owner from terminal/CLI. **No web accounts** exist in early tiers.
3. **Cross-device key linking is launch-tier** — one-time codes (`/invite`-style) bind a second key to the same identity. The first GM with a desktop and a laptop hits this wall immediately.
4. **Browser terminal posture: passkey against the web backend** — a passkey is a keypair, so "your key is your account" survives the browser; the gateway mints the browser session onto the same identity primitive. Details wait on [Browser terminal bridge](004-browser-terminal-bridge.md).

Addendum (Oscar's follow-up — GM roaming): _accessing your own room from any machine_ falls out of parts 1+3 — with linked keys, the GM joins their own room as a participant from anywhere (via gateway or p2p) while the room host stays where it was minted. _Moving the room host itself_ (the authoritative campaign file) is a separate, deferrable question — default answer "the campaign is a file on the GM's disk; move the file" — folded into the CLI artifact scope fog rather than decided here.
