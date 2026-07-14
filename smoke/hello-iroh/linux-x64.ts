const iroh = require("@number0/iroh-linux-x64-gnu/iroh.linux-x64-gnu.node");

const endpoint = await iroh.Endpoint.bind();
console.log(`hello-iroh endpoint ${endpoint.id().toString()}`);
await endpoint.close();
