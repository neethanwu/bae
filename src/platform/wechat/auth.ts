import { getQrCode, getQrCodeStatus } from "./api.ts";
import type { QrStatusResp } from "./types.ts";

export interface WeChatLoginResult {
	token: string;
	botId: string;
	baseUrl: string;
	userId?: string;
}

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export async function loginWithQr(
	apiBaseUrl: string,
): Promise<WeChatLoginResult> {
	let { qrcode, qrcode_img_content } = await getQrCode(apiBaseUrl);

	try {
		const { default: qrcodeTerminal } = await import("qrcode-terminal");
		qrcodeTerminal.generate(qrcode_img_content, { small: true });
	} catch {
		// qrcode-terminal not available, fall through to URL fallback
	}

	console.log(qrcode_img_content);

	const deadline = Date.now() + 480_000;
	const MAX_REFRESHES = 3;
	let refreshCount = 0;
	let scannedPrinted = false;

	while (Date.now() < deadline) {
		const resp: QrStatusResp = await getQrCodeStatus(apiBaseUrl, qrcode);

		switch (resp.status) {
			case "wait":
				break;

			case "scaned":
				if (!scannedPrinted) {
					process.stdout.write("Scanned! Confirm in WeChat...");
					scannedPrinted = true;
				}
				break;

			case "expired":
				refreshCount++;
				if (refreshCount > MAX_REFRESHES) {
					throw new Error("QR code expired too many times");
				}
				({ qrcode, qrcode_img_content } = await getQrCode(apiBaseUrl));
				try {
					const { default: qrcodeTerminal } = await import("qrcode-terminal");
					qrcodeTerminal.generate(qrcode_img_content, {
						small: true,
					});
				} catch {
					// qrcode-terminal not available
				}
				console.log(qrcode_img_content);
				scannedPrinted = false;
				break;

			case "confirmed": {
				if (!resp.bot_token || !resp.ilink_bot_id) {
					throw new Error(
						"Login confirmed but missing credentials in response",
					);
				}
				return {
					token: resp.bot_token,
					botId: resp.ilink_bot_id,
					baseUrl: resp.baseurl ?? apiBaseUrl,
					userId: resp.ilink_user_id,
				};
			}
		}

		await new Promise((r) => setTimeout(r, 1000));
	}

	throw new Error("Login timed out");
}
