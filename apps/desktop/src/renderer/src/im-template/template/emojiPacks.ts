// @ts-nocheck
export type EmojiPackType = "image" | "text";

export type EmojiItem = {
	id: string;
	name: string;
	value: string;
	type: EmojiPackType;
	packId: string;
	packName: string;
	large: boolean;
};

export type EmojiPack = {
	id: string;
	name: string;
	type: EmojiPackType;
	size?: number;
	items: EmojiItem[];
};

export type MessagePart =
	| {
			type: "text";
			value: string;
	  }
	| {
			type: "emoji";
			item: EmojiItem;
			raw: string;
	  };

const tokenPattern =
	/\[\[chat:emoji:([a-z0-9_-]+):([^\]]+)\]\]|\[([^\]\n]{1,32})\]/gi;
const basicEmojiItems: Array<[string, string]> = [
	["微笑", "🙂"],
	["开心", "😄"],
	["笑哭", "😂"],
	["眨眼", "😉"],
	["喜欢", "🥰"],
	["酷", "😎"],
	["思考", "🤔"],
	["惊讶", "😮"],
	["难过", "😢"],
	["生气", "😠"],
	["困", "😴"],
	["赞", "👍"],
	["鼓掌", "👏"],
	["OK", "👌"],
	["爱心", "❤️"],
	["星星", "✨"],
	["火花", "🔥"],
	["礼物", "🎁"],
	["咖啡", "☕"],
	["蛋糕", "🍰"],
	["西瓜", "🍉"],
	["猫猫", "🐱"],
	["狗狗", "🐶"],
	["鱼", "🐟"],
	["月亮", "🌙"],
	["太阳", "☀️"],
	["雨", "🌧️"],
	["彩虹", "🌈"],
	["文件", "📄"],
	["图片", "🖼️"],
	["音乐", "🎵"],
	["游戏", "🎮"],
];

const fufuItems: Array<[string, string]> = Array.from(
	{ length: 17 },
	(_, index) => {
		const id = String(index + 1);
		const fileId = id.padStart(3, "0");
		return [
			id,
			`https://cdn.jsdmirror.com/gh/dogxii/face/fufu/fufu_${fileId}.gif`,
		];
	},
);

const kaomojiItems: Array<[string, string]> = [
	["开心", "(´▽`)"],
	["大笑", "ヽ(°〇°)ﾉ"],
	["害羞", "(⁄ ⁄•⁄ω⁄•⁄ ⁄)"],
	["思考", "(´･_･`)"],
	["无语", "(¬_¬)"],
	["尴尬", "(・_・;)"],
	["哭泣", "(╥﹏╥)"],
	["生气", "(╬ ಠ益ಠ)"],
	["惊讶", "Σ(ﾟДﾟ)"],
	["困", "(-.-)zzZ"],
	["爱心", "(｡♥‿♥｡)"],
	["星星眼", "(✧ω✧)"],
	["得意", "ヽ(✿ﾟ▽ﾟ)ノ"],
	["耸肩", "¯\\_(ツ)_/¯"],
	["无奈", "┐(´∀｀)┌"],
	["傻笑", "(´∀`)"],
	["翻桌", "(╯°□°)╯︵ ┻━┻"],
	["摊手", "╮(╯_╰)╭"],
	["抱抱", "ლ(´ ❥ `ლ)"],
	["拜托", "m(_ _)m"],
	["叹气", "(´-ω-`)"],
	["再见", "ヾ(￣▽￣)Bye~"],
	["躺平", "_(:з」∠)_"],
	["欢呼", "\\(^o^)/"],
];

export const emojiPacks: EmojiPack[] = [
	createImagePack(
		"emoji",
		"表情",
		basicEmojiItems.map(([name, symbol]) => [
			name,
			createPlaceholderEmojiDataUrl(symbol),
		]),
		30,
		false,
	),
	createImagePack("fufu", "敷敷", fufuItems, 80, true),
	createTextPack("kaomoji", "颜文字", kaomojiItems),
];

const emojiItemsByTokenKey = new Map(
	emojiPacks.flatMap((pack) =>
		pack.items.map((item) => [itemKey(pack.id, item.id), item]),
	),
);

const emojiItemsByDisplayKey = new Map(
	emojiPacks.flatMap((pack) =>
		pack.items.flatMap((item) => [
			[displayKey(item), item],
			[`${pack.id}:${item.id}`, item],
		]),
	),
);

export function createEmojiToken(item: EmojiItem) {
	return `[${displayKey(item)}]`;
}

export function parseMessageParts(value: string): MessagePart[] {
	const parts: MessagePart[] = [];
	tokenPattern.lastIndex = 0;
	let cursor = 0;
	let match: RegExpExecArray | null = tokenPattern.exec(value);

	while (match) {
		if (match.index > cursor) {
			parts.push({
				type: "text",
				value: value.slice(cursor, match.index),
			});
		}

		const item = match[1]
			? findEmojiItem(match[1], safeDecode(match[2]))
			: findEmojiItemByDisplayKey(match[3]);
		if (item) {
			parts.push({
				type: "emoji",
				item,
				raw: match[0],
			});
		} else {
			parts.push({
				type: "text",
				value: match[0],
			});
		}

		cursor = match.index + match[0].length;
		match = tokenPattern.exec(value);
	}

	if (cursor < value.length) {
		parts.push({
			type: "text",
			value: value.slice(cursor),
		});
	}

	return parts.length > 0
		? mergeAdjacentText(parts)
		: [{ type: "text", value }];
}

function createImagePack(
	id: string,
	name: string,
	items: Array<[string, string]>,
	size: number,
	large: boolean,
): EmojiPack {
	return {
		id,
		name,
		type: "image",
		size,
		items: items.map(([itemName, value]) => ({
			id: itemName,
			name: itemName,
			value,
			type: "image",
			packId: id,
			packName: name,
			large,
		})),
	};
}

function createTextPack(
	id: string,
	name: string,
	items: Array<[string, string]>,
): EmojiPack {
	return {
		id,
		name,
		type: "text",
		items: items.map(([itemName, value]) => ({
			id: itemName,
			name: itemName,
			value,
			type: "text",
			packId: id,
			packName: name,
			large: false,
		})),
	};
}

function findEmojiItem(packId: string, itemId: string) {
	return emojiItemsByTokenKey.get(itemKey(packId, itemId));
}

function findEmojiItemByDisplayKey(key: string | undefined) {
	if (!key) {
		return undefined;
	}

	return emojiItemsByDisplayKey.get(key);
}

function displayKey(item: EmojiItem) {
	return item.packId === "emoji" ? item.name : `${item.packName}:${item.id}`;
}

function itemKey(packId: string, itemId: string) {
	return `${packId}:${itemId}`;
}

function createPlaceholderEmojiDataUrl(symbol: string) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, system-ui, sans-serif" font-size="48">${escapeSvgText(symbol)}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function mergeAdjacentText(parts: MessagePart[]) {
	return parts.reduce<MessagePart[]>((merged, part) => {
		const previous = merged[merged.length - 1];
		if (part.type === "text" && previous?.type === "text") {
			previous.value += part.value;
			return merged;
		}

		merged.push(part);
		return merged;
	}, []);
}
