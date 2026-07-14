/* oxlint-disable unicorn/prefer-module -- bun build --compile needs a static bare require of the per-triple .node addon (ticket #11) */
const iroh = require("@number0/iroh-linux-arm64-gnu/iroh.linux-arm64-gnu.node");

const endpoint = await iroh.Endpoint.bind();
console.log(`hello-iroh endpoint ${endpoint.id().toString()}`);
await endpoint.close();
