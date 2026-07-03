/**
 * QQ 系统表情映射（faceText ↔ OneBot faceId），数据源 resources/emoji/emojis.json（342 项，
 * 从项目 git 历史 checkout；桌面后来改用 QQ emoji.db 解析，这里给 bot 内置一份静态表，bundle 自包含）。
 *
 * 用途：克隆体回复文本里的系统表情（如 /捂脸）→ OneBot face 段 { type:'face', data:{ id } }，
 * 这样 QQ 客户端才渲染成表情图，而不是显示哑文字「/捂脸」。
 */
import emojis from './emojis.json';
import type { OneBotSegment } from '../adapter/types';

interface EmojiEntry {
  id: string;
  description: string;
  code: string;
  isSpecial: boolean;
  source: string;
}

/** faceText（如 /惊讶）→ OneBot face id（如 "0"）。 */
const FACE_TEXT_TO_ID = new Map<string, string>();
const FACE_ID_TO_TEXT = new Map<string, string>();
for (const e of emojis as EmojiEntry[]) {
  if (e.description && e.id) {
    FACE_TEXT_TO_ID.set(e.description, e.id);
    if (!FACE_ID_TO_TEXT.has(e.id)) FACE_ID_TO_TEXT.set(e.id, e.description);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 按 faceText 长度降序，长的优先匹配（避免 /笑 抢在 /笑哭 前面）。
const FACE_TEXTS = [...FACE_TEXT_TO_ID.keys()].sort((a, b) => b.length - a.length);
const FACE_PATTERN = FACE_TEXTS.length > 0 ? new RegExp(FACE_TEXTS.map(escapeRegExp).join('|'), 'g') : null;

/** faceText → faceId（找不到返回 null）。 */
export function faceTextToId(faceText: string): string | null {
  return FACE_TEXT_TO_ID.get(faceText) ?? null;
}

/** OneBot faceId → faceText（如 "0" → /惊讶）；找不到返回 null。 */
export function faceIdToText(faceId: string): string | null {
  return FACE_ID_TO_TEXT.get(faceId) ?? null;
}

/**
 * 把一段文本按系统表情拆成 text/face 混合段：/捂脸 变成独立 face 段，其余留 text 段。
 * 无表情时返回单个 text 段。空文本返回空数组。
 */
export function splitSystemFaces(text: string): OneBotSegment[] {
  if (!text) return [];
  if (!FACE_PATTERN) return [{ type: 'text', data: { text } }];
  const segs: OneBotSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(FACE_PATTERN)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      const chunk = text.slice(last, idx);
      if (chunk) segs.push({ type: 'text', data: { text: chunk } });
    }
    const id = FACE_TEXT_TO_ID.get(m[0]);
    if (id) segs.push({ type: 'face', data: { id } });
    last = idx + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last);
    if (tail) segs.push({ type: 'text', data: { text: tail } });
  }
  return segs.length > 0 ? segs : [{ type: 'text', data: { text } }];
}
