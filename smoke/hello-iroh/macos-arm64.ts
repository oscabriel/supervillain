const iroh = require("@number0/iroh-darwin-arm64/iroh.darwin-arm64.node");

const endpoint = await iroh.Endpoint.bind();
console.log(`hello-iroh endpoint ${endpoint.id().toString()}`);
await endpoint.close();
