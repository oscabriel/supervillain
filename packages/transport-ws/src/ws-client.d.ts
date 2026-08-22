/**
 * The real `ws` client, imported by file subpath. Bun aliases the bare `"ws"`
 * specifier to its native WebSocket shim, and Bun 1.4's native client ignores
 * `checkServerIdentity`, so a pinned dial to a host outside the certificate's
 * SAN fails its TLS handshake even though the pin already settled trust
 * (NQ-9: identity is the fingerprint, not the hostname). The subpath resolves
 * through the real package — a `patchedDependencies` patch on `ws` adds it to
 * the exports map — and its TLS path rides `node:tls`, which honors
 * `checkServerIdentity` under both runtimes.
 */
declare module "ws/lib/websocket.js" {
	export { WebSocket as default } from "ws";
}
