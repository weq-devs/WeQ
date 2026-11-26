import {
  type EmojiItem,
  systemFaceItem,
  unicodeFaceItem,
} from '../im-template/template/emojiPacks';

export type ReactionItem = { code: string; title: string; item: EmojiItem };
export type FaceGroup = {
  unicode?: boolean;
  items: { id: string | number; desc: string; glyph?: string }[];
};

// macOS QQ 7.0.4 随包的 qqface-reaction 小图使用服务端表情 ID。
const systemReactionCodes = new Set(
  `4 5 8 9 10 12 14 16 21 23 24 25 26 27 28 29 30 32 33 34 38 39 41 42 43 49 53 60 63 66
74 75 76 78 79 85 89 96 97 98 99 100 101 102 103 104 106 109 111 116 118 120 122 123
124 125 129 144 147 171 173 174 175 176 179 180 181 182 183 201 203 212 214 219 222 227
232 240 243 246 262 264 265 266 267 268 269 270 271 272 273 277 278 281 282 284 285 287
289 290 293 294 297 298 299 305 306 307 314 318 319 320 322 324 326 327 328 329 330 331 332`.split(
    /\s+/,
  ),
);

// 桌面 QQ 随包字符表情目录，扣除 Android QQ 9.3.85 回应面板过滤的字符。
const unicodeReactionGlyphs = new Set(
  `☀ ☕ ☺ ✨ ❔ 🌹 🍉 🍎 🍓 🍜 🍞 🍧 🍺 🍻 🎉 🐛 🐮 🐳 🐵 👊 👌 👍 👏 👦 👧
💓 💝 💤 💦 💨 💪 📫 🔥 😁 😂 😄 😊 😌 😏 😒 😓 😔 😘 😚 😜 😝 😭 😰 😳`.split(/\s+/),
);

export const REACTION_BUTTON_MIN_WIDTH = 44;

/** 使用实际内容宽度，始终为更多表情预留一格。 */
export function quickReactionCapacity(width: number): number {
  return Number.isFinite(width)
    ? Math.max(0, Math.floor(width / REACTION_BUTTON_MIN_WIDTH) - 1)
    : 0;
}

export function reactionItems(groups: readonly FaceGroup[]): ReactionItem[] {
  const items = new Map<string, ReactionItem>();
  for (const group of groups) {
    for (const face of group.items) {
      const id = String(face.id);
      if (group.unicode) {
        const glyph = face.glyph || id;
        if (!unicodeReactionGlyphs.has(glyph)) continue;
        const code = String(glyph.codePointAt(0));
        if (!items.has(code))
          items.set(code, { code, title: face.desc, item: unicodeFaceItem(glyph, face.desc) });
      } else if (systemReactionCodes.has(id) && !items.has(id)) {
        items.set(id, { code: id, title: face.desc, item: systemFaceItem(id, face.desc) });
      }
    }
  }
  return [...items.values()];
}

// 使用现有系统表情资源；目录尚未返回时也能立即绘制默认回应。
const defaultReactions: ReactionItem[] = [
  ['76', '赞'],
  ['66', '爱心'],
  ['14', '微笑'],
  ['9', '大哭'],
  ['182', '笑哭'],
  ['49', '抱抱'],
].map(([code, title]) => ({ code: code!, title: title!, item: systemFaceItem(code!, title!) }));

export function quickReactions(
  recent: readonly string[],
  catalog: readonly ReactionItem[],
): ReactionItem[] {
  const items = new Map([...defaultReactions, ...catalog].map((item) => [item.code, item]));
  return [...new Set([...recent, ...defaultReactions.map((item) => item.code)])]
    .flatMap((code) => (items.has(code) ? [items.get(code)!] : []))
    .slice(0, 6);
}

export { defaultReactions as DEFAULT_REACTIONS };
