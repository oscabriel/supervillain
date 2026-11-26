# Tables live at `<handle>/<table>` on a relay, held by the GM's own key

## Decision

A relay addresses a table as `<handle>/<table>` (`ssh ana/den@relay`, or `ana.den`). A handle (1–24 of `a-z`, `0-9`, `-`, starting with a letter, not a reserved word) belongs to the GM, not to a campaign: `supervillain host --handle ana --relay …` presents the GM's per-machine key, `<config>/supervillain/gm_key` (`$XDG_CONFIG_HOME`, else `~/.config`, mode `0600`), on the relay link through `AttachOptions.hostKey`, while direct players still see the campaign's `host_key`. The relay records `handles.json` as `{ handle: { keys, claimed, seen } }`: up to 4 keys a handle (another machine joins with a single-use `sv-` claim code that a key holding the handle mints, 15 minutes, at most 3 live per key and 256 per relay, bad guesses rate-limited per address, spent only once `addKey` adds the key, so a handle at its most keys refuses and leaves the code live), 4,096 handles (a full registry drops only lapsed handles and otherwise refuses the new claim, never evicting a live one), 8 open tables a handle, a lapse after 180 days unseen (30 if it never linked a table), and a linked handle never lapses. The link speaks protocol 2, `SUPERVILLAIN 2 TABLE <handle>/<table>[ CLAIM <proof>]`, where the proof is `base64url(HMAC-SHA256(code, fingerprint))` over the SHA256 fingerprint of the GM key the host is about to present; the relay checks it in `verifyHostKey(offered)` and again under its claims semaphore, with `timingSafeEqual` against each live code for that handle and the key actually offered; a protocol 1 hello is told to upgrade, and a protocol 1 `rooms.json` is renamed `rooms.json.legacy` when the relay starts. A bare `ssh <table>@relay` is the returning player's shorthand: the relay asks `knows-1` only of the live tables of that name (or of that handle), seats the player at the one that knows their key with `Joining <handle>/<table>…`, lists them when several do, and otherwise shows the plain lobby and join hint, the same whether or not any table of that name is open. An invite token after `~` in the user name is stripped before routing and passed to the table as `SV_INVITE`, trusted only from a pinned relay.

## Why

- One GM runs several campaigns from one machine; a handle held by the GM's key lets every table share one name players learn once, without re-claiming per campaign folder.
- The hello travels before SSH, in the clear. Binding the proof to the presented key means someone on the path learns neither the code nor anything another key can use, at no extra round-trip.
- Evicting a live handle to make room hands a GM's name to whoever claims last, so a full registry refuses instead.
- Keeping `host_key` for direct players means a GM who switches a table between LAN and relay never changes what direct players' `known_hosts` already trust.
- Namespacing by handle frees short table names (`den`, `keep`) from first-come squatting across the whole relay.
- The shorthand probes only tables of that name and says nothing different when none is open, so a stranger can't tell from the answer whether a table of that name exists.

## What breaks if you change this

- Presenting the campaign's `host_key` on the link again makes each campaign a separate claimant, so a GM's second campaign is refused under their own handle.
- Sending the code itself in `CLAIM`, or a proof not bound to the offered key, lets an eavesdropper race the GM's machine to the handle with their own key.
- Spending the code before `addKey` succeeds burns it when the handle is at its most keys, so the GM needs a fresh code after freeing a slot.
- Appending `hostKey` to `hostKeys` instead of replacing lets ssh2 negotiate either key, so the relay may see the campaign key and refuse the handle.
- Probing `knows-1` on every live link for the shorthand leaks the player's key to every GM on the relay as a yes/no oracle.
- Routing before stripping `~<invite>` sends the token to the relay's lobby text and logs, where it no longer stays between the GM and the invited player.
