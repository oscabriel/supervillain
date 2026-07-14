// @number0/iroh@1.0.0 does not currently publish this artifact. This entry keeps
// the required native CI triple explicit and will become buildable when it does.
const iroh = require("@number0/iroh-darwin-x64/iroh.darwin-x64.node");

const endpoint = await iroh.Endpoint.bind();
console.log(`hello-iroh endpoint ${endpoint.id().toString()}`);
await endpoint.close();
