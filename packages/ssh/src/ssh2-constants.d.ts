declare module "ssh2/lib/protocol/constants.js" {
	const protocolConstants: { readonly SUPPORTED_KEX: ReadonlyArray<string> };

	export default protocolConstants;
}
