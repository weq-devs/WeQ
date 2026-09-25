// @ts-nocheck
/**
 * 输入框 / 草稿里表情 token 的解析与构造。
 *
 * 面板选中的表情在输入框里以 token 字符串保存，`contentEditable` 再把 token
 * 反解成预览元素（图片 / 字符）。token 形态：
 *
 *   [[chat:face:<faceId>]]                     QQ 系统表情（图片，weq-asset）
 *   [[chat:face:<faceId>:big]]                 同一枚表情按大表情（超级表情）发：
 *                                              走 superSticker（serviceType 37）
 *                                              那条 wire 形态，只能单独成一条消息
 *   [[chat:mface:<packId>:<hash>]]             商城表情（TEA 解密 GIF）
 *   [[chat:fav:<scope>:<bucket>:<v>:<file>]]   收藏自定义表情（weq-media cemoji）
 *   [[chat:gif:<dirHash>:<file>]]              关联 GIF（weq-media relemoji）
 *   [[chat:elem:<base64url(JSON)>>]]           其它草稿元素（图片/文件/ark…，见 draftElements）
 *
 * 纯 Unicode 字符表情直接以字形文本插入，不产生 token（避免和图片表情混在同
 * 一条「最近使用」里）。旧的 `[名字]` 写法仍按纯文本保留，不再解析成表情。
 */

import { emojiUrl, mediaUrl } from '../../lib/resourceUrl';

export type EmojiKind = 'system' | 'unicode' | 'market' | 'fav' | 'related';

export type EmojiItem = {
  kind: EmojiKind;
  /** 稳定 key（系统表情 = faceId；其它按 token 派生）。 */
  id: string;
  /** 外显名（`[微笑]` / 文件名等）。 */
  name: string;
  /** 插入输入框的 token。 */
  token: string;
  /** 预览图 src（unicode 为 null）。 */
  src: string | null;
  /** unicode 字形（非 unicode 为 ''）。 */
  glyph: string;
  /**
   * 大表情（超级表情）：按贴纸形态发（superSticker，只能单独成一条消息），面板与
   * 占位卡片上用静态小图预览。
   */
  large: boolean;
};

export type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'emoji'; item: EmojiItem; raw: string }
  | { type: 'element'; raw: string };

const elementTokenPattern = '\\[\\[chat:elem:([^\\]]+)\\]\\]';
// `:big` 走非捕获组 —— 面板里选大表情时才会带上，好让下游把它当贴纸发；捕获组
// 序号不动，`itemFromMatch` 里按整串判断即可。
const faceTokenPattern = '\\[\\[chat:face:([0-9]+)(?::big)?\\]\\]';
const mfaceTokenPattern = '\\[\\[chat:mface:([^:\\]]+):([^\\]]+)\\]\\]';
const favTokenPattern = '\\[\\[chat:fav:([^:\\]]+):([^:\\]]*):([^:\\]]+):([^\\]]+)\\]\\]';
const gifTokenPattern = '\\[\\[chat:gif:([^:\\]]+):([^\\]]+)\\]\\]';

const tokenPattern = new RegExp(
  [
    elementTokenPattern,
    faceTokenPattern,
    mfaceTokenPattern,
    favTokenPattern,
    gifTokenPattern,
  ].join('|'),
  'gi',
);

// ── token 构造 ────────────────────────────────────────────────────────────────

/**
 * QQ 系统表情（图片）。
 *
 * `large` = 这枚表情要按**大表情 / 超级表情**发：token 上多带一个 `:big`（下游据此
 * 走 superSticker，且只能单独成一条消息）。小黄脸等常规表情保持内联小图，可以和文字
 * 合成一条消息。
 */
export function systemFaceItem(
  faceId: string | number,
  desc: string,
  large = false,
): EmojiItem {
  const id = String(faceId);
  return {
    kind: 'system',
    id,
    name: desc || `[表情${id}]`,
    token: large ? `[[chat:face:${id}:big]]` : `[[chat:face:${id}]]`,
    src: emojiUrl(id, 'apng', `${id}.png`),
    glyph: '',
    large,
  };
}

/** Unicode 字符表情（直接插字形文本）。 */
export function unicodeFaceItem(glyph: string, desc: string): EmojiItem {
  return {
    kind: 'unicode',
    id: glyph,
    name: desc || glyph,
    token: glyph,
    src: null,
    glyph,
    large: false,
  };
}

/** 商城表情。 */
export function marketFaceItem(packId: string, hash: string, name: string): EmojiItem {
  return {
    kind: 'market',
    id: `${packId}:${hash}`,
    name: name || hash,
    token: `[[chat:mface:${packId}:${hash}]]`,
    src: mediaUrl('mface', { pack: packId, hash, enc: 'tea' }),
    glyph: '',
    large: true,
  };
}

/** 收藏自定义表情；`variant` 选中实际存在的那个文件（ori / thumb）。 */
export function favEmojiItem(
  scope: string,
  bucket: string,
  variant: 'ori' | 'thumb',
  file: string,
  name: string,
): EmojiItem {
  return {
    kind: 'fav',
    id: `${scope}:${bucket}:${file}`,
    name: name || file,
    token: `[[chat:fav:${scope}:${bucket}:${variant}:${file}]]`,
    src: mediaUrl('cemoji', { scope, bucket, v: variant, file }),
    glyph: '',
    large: true,
  };
}

/** 关联 GIF。 */
export function relatedEmojiItem(dirHash: string, file: string, name: string): EmojiItem {
  return {
    kind: 'related',
    id: `${dirHash}:${file}`,
    name: name || file,
    token: `[[chat:gif:${dirHash}:${file}]]`,
    src: mediaUrl('relemoji', { hash: dirHash, file }),
    glyph: '',
    large: true,
  };
}

/** 一枚表情的 token；unicode 直接是字形。 */
export function createEmojiToken(item: EmojiItem): string {
  return item.token;
}

// ── token 解析 ────────────────────────────────────────────────────────────────

/** 把草稿正文拆成 文本 / 表情 / 元素 三类片段。 */
export function parseMessageParts(value: string): MessagePart[] {
  const parts: MessagePart[] = [];
  tokenPattern.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null = tokenPattern.exec(value);

  while (match) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, match.index) });
    }

    if (match[1] !== undefined) {
      // 元素 token：输入框把它当 chip 渲染，内容由 draftElements 还原。
      parts.push({ type: 'element', raw: match[0] });
    } else {
      const item = itemFromMatch(match);
      if (item) {
        parts.push({ type: 'emoji', item, raw: match[0] });
      } else {
        parts.push({ type: 'text', value: match[0] });
      }
    }

    cursor = match.index + match[0].length;
    match = tokenPattern.exec(value);
  }

  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) });
  }

  return parts.length > 0 ? mergeAdjacentText(parts) : [{ type: 'text', value }];
}

function itemFromMatch(match: RegExpExecArray): EmojiItem | null {
  // 捕获组顺序与 tokenPattern 一一对应：1=elem 2=face 3,4=mface 5,6,7,8=fav 9,10=gif。
  if (match[2] !== undefined) return systemFaceItem(match[2], '', match[0].includes(':big'));
  if (match[3] !== undefined && match[4] !== undefined) {
    return marketFaceItem(match[3], match[4], '');
  }
  if (match[5] !== undefined && match[8] !== undefined) {
    const variant = match[7] === 'ori' ? 'ori' : 'thumb';
    return favEmojiItem(match[5], match[6] ?? '', variant, match[8], '');
  }
  if (match[9] !== undefined && match[10] !== undefined) {
    return relatedEmojiItem(match[9], match[10], '');
  }
  return null;
}

function mergeAdjacentText(parts: MessagePart[]): MessagePart[] {
  return parts.reduce((merged, part) => {
    const previous = merged[merged.length - 1];
    if (part.type === 'text' && previous?.type === 'text') {
      previous.value += part.value;
      return merged;
    }
    merged.push(part);
    return merged;
  }, []);
}
