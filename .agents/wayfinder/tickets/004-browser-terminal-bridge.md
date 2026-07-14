---
status: closed
type: research
assignee: pi:bridge
blocked-by: []
---

# Browser terminal bridge

## Question

How does an in-browser terminal reach the _same_ sessions that real terminals reach via `@opentui/ssh`? Candidate shapes: (a) xterm.js + WebSocket→SSH bridge at the gateway (browser speaks a socket, gateway terminates it into the existing SSH/session machinery); (b) a parallel entry point into the same renderer factory (a WebSocket session type alongside SSH sessions, one renderer per connection either way); (c) something OpenTUI already offers (`packages/web`?). Ground the answer in the OpenTUI source clone (path in CLAUDE.md — API truth, never guess). Output: a markdown asset naming the recommended shape, what it demands of the web backend, and what identity looks like for a browser client (no SSH key in play).

Notes from later decisions: identity posture is **passkey against the web backend** ([Identity across surfaces](009-identity-across-surfaces.md)); browser access is a perk of the paid "host your game on our servers" tier ([Business shape](011-business-shape.md)), so the bridge primarily serves gateway-hosted rooms and may assume the gateway is in the loop.

## Resolution

Recommend xterm.js over a binary WebSocket to a gateway-side sibling session adapter, not SSH tunneled through WebSocket and not a browser VTT implementation. OpenTUI core accepts custom streams, while `@opentui/ssh` demonstrates the renderer, resize, backpressure, admission, and teardown lifecycle but is coupled to ssh2. The web backend mints a short-lived, one-use, room-scoped grant from the passkey session; the gateway redeems it into the canonical principal and shared room/session factory. OpenTUI ships no browser renderer in the pinned revision; `packages/web` is its docs site. Findings, protocol demands, identity flow, alternatives, and risks: [browser terminal bridge](../assets/browser-terminal-bridge.md).
