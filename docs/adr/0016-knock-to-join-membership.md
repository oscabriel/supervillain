# Players knock to join; membership lives in the log, knocks and invites in memory

## Decision

The table's core slice holds `members` (`"in"` or `"out"` per actor) and a `door` (`"knock"`, the default, or `"open"`). `isMember` is true for the GM, for an actor marked `"in"`, and for an actor not marked `"out"` when the door is open or the actor already appears in the log. `compose.decide` refuses every command from anyone else with `Knock first: the GM hasn't let you in.` The GM changes membership with logged commands: `/admit <who>` writes `core.member-admitted { member, name, by }`, which also sets the name; `/kick <who>` writes `core.member-removed` and the host closes that actor's live seats, while every player seat also follows `room.changes` and closes itself the moment `isMember` turns false (closing the race with a seat opening during `/kick`, and sending off passers-by when `/door knock` shuts an open door); `/door knock|open` writes `core.door-set` (also `supervillain host --door`). A stranger's shell opens a door screen instead of the table, which closes if they name nobody for 2 minutes: they pick a name checked by `checkName` (the same rules as `/name`, ignoring a name the log already gives them), the knock waits in the host's memory (16 at most, 1 a key, 3 an address bucket, 10 minutes before it expires, 10 minutes' cooldown after `/deny` on both the key and the address bucket), and the GM's seat shows the oldest with its key's short fingerprint, `[Admit]` `[Deny]` and Alt+Y / Alt+N. `/admit` reaches the knock through the `Knocks` external port during `intake`, so `{ member, name }` rides in the event; a name two knockers share is refused with both fingerprints' starts rather than admitting the first. The address bucket is `addressBucket(remoteAddress)` for a direct player and, through a relay, `SV_BUCKET`: `base64url(HMAC-SHA256(secret, addressBucket(address)))` under a random 32-byte secret the relay draws at boot, stripped from what players send and trusted only from a pinned relay, like `SV_ACTOR` and `SV_INVITE`. `/invite [uses] [minutes]` mints a token held only in memory; a player who joins with `~<token>` names themself and is admitted `by: "invite"`. A use is held while the admission runs and handed back if it fails, and an actor marked `"out"` never sits down on an invite: they knock like a stranger. A one-off `ssh … command` from a non-member is refused on stderr, and the relay lobby's `knows-1` answers only for members.

## Why

- A public relay address is guessable; the GM, not the address, decides who sits down.
- Every log written before knocking grandfathers its players with no migration, since anyone who appears in it counts as let in until removed.
- Knocks and invites are not play, so they never touch the append-only log; who was admitted, and under what name, is.
- Through a relay every player shares the relay's address, and a fresh key or guest costs nothing, so per-address limits and the `/deny` cooldown key on the relay's opaque bucket; the host learns that two knocks came from one place, never where.
- A kick is the GM's word; an invite minted before it is not a way back in.

## What breaks if you change this

- Moving the gate out of `decide` leaves the exec path and any future surface able to write a stranger's events to the log.
- Resolving `/admit` in `decide` instead of `intake` makes replay depend on the host's memory of who knocked.
- Dropping the grandfather clause locks every existing player out of every existing campaign on upgrade.
- Keying knocks through a relay on the relayed actor lets a turned-away stranger knock again at once with a new key or as a new guest, and hold every pending slot.
- Spending an invite before the admission is written burns a use on a refused name or a full log.
- Answering `knows-1` from `state.actors` alone lists a kicked player's tables to them, and treats an open door's passers-by like members.
