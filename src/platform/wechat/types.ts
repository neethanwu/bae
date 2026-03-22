// iLink Bot API protocol types for WeChat

export const MessageType = {
	NONE: 0,
	USER: 1,
	BOT: 2,
} as const;

export const MessageItemType = {
	NONE: 0,
	TEXT: 1,
	IMAGE: 2,
	VOICE: 3,
	FILE: 4,
	VIDEO: 5,
} as const;

export const MessageState = {
	NEW: 0,
	GENERATING: 1,
	FINISH: 2,
} as const;

export interface TextItem {
	text?: string;
}

export interface MessageItem {
	type?: number;
	create_time_ms?: number;
	text_item?: TextItem;
	/** Placeholder for future image support */
	image_item?: object;
	/** Voice transcription */
	voice_item?: { text?: string };
	file_item?: { file_name?: string };
	/** Placeholder for future video support */
	video_item?: object;
}

export interface WeChatMessage {
	seq?: number;
	message_id?: number;
	from_user_id?: string;
	to_user_id?: string;
	client_id?: string;
	create_time_ms?: number;
	session_id?: string;
	message_type?: number;
	message_state?: number;
	item_list?: MessageItem[];
	context_token?: string;
}

export interface GetUpdatesResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	msgs?: WeChatMessage[];
	get_updates_buf?: string;
	longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
	msg: WeChatMessage;
}

export interface GetConfigResp {
	ret?: number;
	errmsg?: string;
	typing_ticket?: string;
}

export interface QrCodeResp {
	qrcode: string;
	qrcode_img_content: string;
}

export interface QrStatusResp {
	status: "wait" | "scaned" | "confirmed" | "expired";
	bot_token?: string;
	ilink_bot_id?: string;
	baseurl?: string;
	ilink_user_id?: string;
}
