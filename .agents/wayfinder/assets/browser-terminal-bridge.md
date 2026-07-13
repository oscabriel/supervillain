# Browser terminal bridge

## Recommendation

Use **xterm.js in the browser with a purpose-built binary WebSocket session endpoint on the gateway**, as a sibling transport to SSH. The endpoint should adapt WebSocket input/output/resize/close events to the same server-side OpenTUI renderer factory and room/session handler used by SSH. Do not tunnel SSH and do not build a browser VTT renderer.

This is candidate (b), not WebSocket→SSH. The useful seam is below SSH authentication and shell protocol but above renderer creation: a transport-neutral session adapter. `@opentui/ssh` itself is SSH-specific—its public identity union only represents SSH methods (`packages/ssh/src/types.ts:15-26`), and its connection layer performs ssh2 authentication, PTY, window-change, and shell handling (`packages/ssh/src/connection.ts:49-89`, `packages/ssh/src/connection.ts:91-139`). A WebSocket endpoint therefore cannot directly reuse that public machinery without pretending to be ssh2; it should lift the proven lifecycle pattern into the product's own shared session factory.

## What the SSH package actually wires

For each accepted shell, the connection layer creates a bridge with the authenticated identity and captured PTY, tracks it against limits/teardown, then runs the middleware/handler chain (`packages/ssh/src/connection.ts:91-132`). The bridge:

- converts channel data into a Node `Readable`, pausing the SSH channel under input backpressure (`packages/ssh/src/bridge.ts:40-61`);
- converts renderer writes into channel writes, waiting for `drain` rather than dropping frames, and exposes `columns`/`rows` on the custom writable (`packages/ssh/src/bridge.ts:63-97`);
- delays renderer creation until middleware admits the session (`packages/ssh/src/bridge.ts:126-146`, `packages/ssh/src/run-session.ts:40-65`);
- creates `createCliRenderer` with custom streams, current dimensions, no process signal ownership, and no global console patch (`packages/ssh/src/bridge.ts:308-334`);
- forwards SSH `window-change` to `bridge.resize` (`packages/ssh/src/connection.ts:85-89`), which updates stream dimensions, renderer dimensions, and listeners (`packages/ssh/src/bridge.ts:226-237`);
- converges disconnect, renderer destruction, idle/max timeout, and handler completion on idempotent teardown (`packages/ssh/src/bridge.ts:257-305`, `packages/ssh/src/bridge.ts:337-364`).

Core explicitly supports this architecture. Any readable/writable may be supplied, with dimensions supplied on the writable or as fallbacks (`packages/core/src/renderer.ts:100-121`). Custom output is routed through `NativeSpanFeed` (`packages/core/src/renderer.ts:105-108`, `packages/core/src/renderer.ts:952-959`) and defaults to remote mode (`packages/core/src/renderer.ts:1031-1040`). Custom transports must call `renderer.resize` because SIGWINCH is only installed for real process stdout (`packages/core/src/renderer.ts:1160-1166`, `packages/core/src/renderer.ts:3791-3802`).

## Proposed protocol and flow

1. The authenticated web app requests a short-lived, single-use terminal grant for a specific room (and, if applicable, player/seat). The web backend verifies the passkey-backed web session, paid entitlement, room membership, and gateway placement.
2. The browser opens `wss://…/terminal` and presents the opaque grant in the first protocol message (preferable to a query string that leaks into logs). The gateway validates audience, room, subject, expiry, nonce, and one-time use, then constructs the product's canonical principal directly—there is no SSH key and no SSH `Identity` fabrication.
3. The gateway admits that principal through the same authorization/room lookup and session-limit policy used after SSH authentication, then creates one renderer using a WebSocket stream adapter and the same VTT mount/handler factory.
4. Use binary WebSocket messages for terminal byte traffic in both directions. xterm.js `onData` UTF-8 bytes—including control/escape sequences—flow to renderer stdin; renderer stdout bytes flow unchanged to xterm.js `write`. Do not decode/re-encode ANSI as text on the gateway.
5. Use a small, versioned control envelope distinct from byte frames (for example text JSON or a tagged binary frame) for initial `{term, cols, rows}`, resize, ping, and close. `ResizeObserver`/xterm fit calculates columns and rows; resize messages call the same transport-neutral resize operation. Clamp dimensions as the SSH bridge does (its current maxima are 500×200: `packages/ssh/src/bridge.ts:19-20`, `packages/ssh/src/bridge.ts:25-38`).

The web backend owns passkey login, entitlement/membership checks, grant minting, CSRF/origin policy for grant creation, and revocation/audit. The gateway owns grant redemption, WebSocket origin checks, transport/session limits, byte and resize rate limits, room routing, renderer lifecycle, and close cleanup. Grants should be narrowly scoped, very short-lived, bound to the intended gateway and room, and never reusable. Browser reconnect creates a new renderer session unless a later, separately specified room-session resume model exists.

## Capability behavior

OpenTUI sends terminal capability queries and parses replies arriving on renderer stdin: startup installs a five-second capability timeout (`packages/core/src/renderer.ts:3090-3124`), input bytes feed the parser (`packages/core/src/renderer.ts:3168-3177`), and recognized responses update capabilities (`packages/core/src/renderer.ts:3205-3223`). Thus the WebSocket is not intrinsically a blocker: queries emitted to stdout reach xterm.js, whose replies can return over `onData`. But xterm.js's exact replies and enabled addons/modes must be integration-tested; missing replies imply timeout/conservative capability behavior. Advertise a truthful terminal name (likely `xterm-256color` after verification), not capabilities the emulator does not implement.

## Why not the alternatives

### OpenTUI browser package

There is no shipped browser OpenTUI renderer in this revision. `packages/web` is a private Astro documentation site—its package metadata names Astro and workspace docs dependencies (`packages/web/package.json:2-22`). OpenTUI describes the renderer as native Zig/FFI (`packages/web/src/content/docs/getting-started.mdx:13-19`, `packages/web/src/content/docs/getting-started.mdx:32-35`). The canvas component is site presentation (`packages/web/src/components/TuiSurface.astro:1-20`), not a published browser renderer. Browser-oriented keymap support does not change the rendering calculus.

### SSH over WebSocket proxy

A byte proxy preserving the entire SSH protocol could reuse `@opentui/ssh` unchanged, but browsers lack a native SSH client: the product would need to ship/maintain one (often WASM), invent browser-side SSH credentials or another SSH auth mapping, and proxy WebSocket framing to TCP. That adds encryption/handshake overhead inside TLS, duplicates identity semantics, and makes resize and lifecycle traverse SSH solely to reach a renderer that already accepts arbitrary streams. It is only attractive as a temporary off-the-shelf operational experiment, not the product seam.

## Risks and validation gates

- **Capability fidelity:** test query/reply behavior, colors, Unicode width, mouse, paste, focus, keyboard protocols, and clipboard against the pinned OpenTUI revision and chosen xterm.js/addons.
- **Binary integrity:** specify frame tags and prohibit accidental UTF-16/string conversion, concatenation assumptions, or control/data ambiguity. WebSocket message boundaries are not terminal record boundaries.
- **Backpressure:** browser `bufferedAmount` and server write queues need bounded high-water marks and disconnect policy; copy the SSH bridge's no-drop/backpressure intent rather than unbounded buffering.
- **Latency:** measure input-to-paint and resize under realistic WAN conditions; coalescing output can help throughput but must not make interactions sticky.
- **Security:** single-use grants, strict audience/room binding, origin checks, log redaction, revocation, rate limits, and authorization shared with SSH are release gates.
- **Seam maintenance:** `createSessionBridge` is currently typed directly to ssh2 `ServerChannel` (`packages/ssh/src/bridge.ts:114-133`); do not import that internal function as the WebSocket API. Keep a product-owned transport-neutral session contract and test both adapters against it.
