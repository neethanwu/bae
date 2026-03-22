import crypto from "node:crypto";
import type {
	GetConfigResp,
	GetUpdatesResp,
	QrCodeResp,
	QrStatusResp,
	SendMessageReq,
} from "./types.ts";

export type WeChatApiOpts = {
	baseUrl: string;
	token: string;
};

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders(
	token: string,
	bodyByteLength: number,
): Record<string, string> {
	const uint32 = crypto.randomBytes(4).readUInt32BE(0);
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		AuthorizationType: "ilink_bot_token",
		"Content-Length": String(bodyByteLength),
		"X-WECHAT-UIN": Buffer.from(String(uint32), "utf-8").toString("base64"),
	};
}

async function apiFetch(params: {
	baseUrl: string;
	endpoint: string;
	body: string;
	token?: string;
	timeoutMs: number;
	label: string;
}): Promise<string> {
	const { baseUrl, endpoint, body, token, timeoutMs, label } = params;
	const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const headers = token
			? buildHeaders(token, Buffer.byteLength(body, "utf-8"))
			: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(body, "utf-8")),
				};

		const resp = await fetch(url.toString(), {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});

		if (!resp.ok) {
			throw new Error(`${label}: HTTP ${resp.status} ${resp.statusText}`);
		}

		return await resp.text();
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			throw new Error(`${label}: timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

export async function getUpdates(
	opts: WeChatApiOpts,
	getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
	try {
		const text = await apiFetch({
			baseUrl: opts.baseUrl,
			endpoint: "ilink/bot/getupdates",
			body: JSON.stringify({ get_updates_buf: getUpdatesBuf }),
			token: opts.token,
			timeoutMs: 40_000,
			label: "getUpdates",
		});
		return JSON.parse(text) as GetUpdatesResp;
	} catch (err) {
		if (err instanceof Error && err.message.includes("timed out")) {
			return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
		}
		throw err;
	}
}

export async function sendMessage(
	opts: WeChatApiOpts,
	body: SendMessageReq,
): Promise<void> {
	await apiFetch({
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		body: JSON.stringify(body),
		token: opts.token,
		timeoutMs: 15_000,
		label: "sendMessage",
	});
}

export async function sendTyping(
	opts: WeChatApiOpts,
	body: { ilink_user_id: string; typing_ticket: string; status?: number },
): Promise<void> {
	await apiFetch({
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/sendtyping",
		body: JSON.stringify(body),
		token: opts.token,
		timeoutMs: 10_000,
		label: "sendTyping",
	});
}

export async function getConfig(
	opts: WeChatApiOpts,
	ilinkUserId: string,
	contextToken?: string,
): Promise<GetConfigResp> {
	const text = await apiFetch({
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/getconfig",
		body: JSON.stringify({
			ilink_user_id: ilinkUserId,
			context_token: contextToken,
		}),
		token: opts.token,
		timeoutMs: 10_000,
		label: "getConfig",
	});
	return JSON.parse(text) as GetConfigResp;
}

export async function getQrCode(
	baseUrl: string,
	botType = "3",
): Promise<QrCodeResp> {
	const url = new URL(
		`ilink/bot/get_bot_qrcode?bot_type=${botType}`,
		ensureTrailingSlash(baseUrl),
	);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);

	try {
		const resp = await fetch(url.toString(), {
			method: "GET",
			signal: controller.signal,
		});

		if (!resp.ok) {
			throw new Error(`getQrCode: HTTP ${resp.status} ${resp.statusText}`);
		}

		return (await resp.json()) as QrCodeResp;
	} finally {
		clearTimeout(timer);
	}
}

export async function getQrCodeStatus(
	baseUrl: string,
	qrcode: string,
): Promise<QrStatusResp> {
	const url = new URL(
		`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
		ensureTrailingSlash(baseUrl),
	);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 35_000);

	try {
		const resp = await fetch(url.toString(), {
			method: "GET",
			headers: { "iLink-App-ClientVersion": "1" },
			signal: controller.signal,
		});

		if (!resp.ok) {
			throw new Error(
				`getQrCodeStatus: HTTP ${resp.status} ${resp.statusText}`,
			);
		}

		return (await resp.json()) as QrStatusResp;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			return { status: "wait" };
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
