# Issue 0005: Sandbox Tables in the Relay, and OpenSSH `ControlPath %r`

## Status

Known limits of the lobby's Try a Table tab and of the returning-player shorthand.

## 1. A sandbox is a real table inside the relay process

The lobby's Try a Table tab (`apps/supervillain/src/relay/sandbox.ts`) runs a whole GM table on the visitor's SSH channel: `sandboxServices` builds `TableRoom`, `CampaignContent` and the ports over the embedded sample campaign, with `JsonlPlatform.layerMemory` in place of `events.jsonl`. Consequently:

- Nothing touches the relay's disk. The log is a `Ref` capped at 2,000 lines (`CampaignLog.memory`); at the cap the room halts like a full disk and refuses every command. `/map new` keeps up to 16 generated maps in `MemoryMaps`, and `SetWorldRefusing` answers instead of set.world, so a sandbox makes no outbound HTTP.
- The relay pays for each sandbox in memory and CPU: one Solid/OpenTUI renderer, one domain fold and one log of up to 2,000 lines. The caps in `RelayOptions.sandbox` bound it: 12 live at once (`--sandboxes N`, `0` turns them off), one per address bucket, one per SSH key, 5 minutes idle, 20 minutes in all, `PLAYER_RATE` on the GM's lines, and a terminal of at least 100×30.
- The visitor sits as `GM`, so a sandbox throttles the GM, which a hosted table never does (`TableRoomOptions.sandbox`). The setup lines run first, each in its own rate bucket.
- A sandbox's failures stay in its scope: `runSandbox` logs any failure or defect and closes the channel; the relay keeps serving. A defect in a shared module (OpenTUI's native renderer, say) could still take the process down, which a hosted table never risks for the relay.
- When a sandbox ends, the renderer restores the terminal and the channel closes with status 0. The visitor isn't returned to the lobby: the channel's input was the renderer's, and a fresh `ssh` gets a fresh lobby.

## 2. OpenSSH `ControlPath %r` and the returning-player shorthand

The relay reads the table's address from the SSH user name (`ssh ana/den@relay`, or `ssh den@relay` for the shorthand). OpenSSH's connection sharing keys a master connection on `ControlPath`; a common setting such as `ControlPath ~/.ssh/cm-%r@%h:%p` puts the user name, and so the address, into a socket path:

- `ana/den` holds a `/`, so the socket path names a directory that doesn't exist and `ssh` fails before it connects. Players who share connections join with `ana.den@relay` instead, which the relay reads the same way.
- With `ControlMaster auto`, a second `ssh` to the same relay can ride the first one's connection, whose user name, and so table, is the first one's. Players see the table they joined before. `ssh -S none ana.den@relay` (or `ControlPath none` for the relay's host) opens a fresh connection.
