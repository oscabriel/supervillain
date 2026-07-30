declare module "qrcode-terminal" {
	interface QrOptions {
		readonly small?: boolean;
	}

	interface QrCodeTerminal {
		readonly generate: (
			input: string,
			options: QrOptions,
			callback: (qr: string) => void
		) => void;
	}

	const qrcode: QrCodeTerminal;
	export default qrcode;
}
