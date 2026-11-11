import { mediaUrl } from './resourceUrl';
import type { Message } from '../im-template/template/types';

/** 显式目标优先，避免多图消息总是收藏第一张，或误用 CDN 缩略图。 */
export function messageFavoriteEmojiUrl(message: Message, target?: EventTarget | null) {
  if (target instanceof Element) {
    const media = target.closest('[data-favorite-emoji-source]');
    if (media) return media.getAttribute('data-favorite-emoji-source') || undefined;
    // 正文里点击的是其他图标（例如内联系统表情）时不回退到另一张图片。
    if (target instanceof HTMLImageElement) return undefined;
  }
  const elements = (message.qqElements ?? []).filter(
    (element) => !(element.type === 'text' && !String(element.data?.textContent ?? '').trim()),
  );
  if (elements.length !== 1) return undefined;
  const element = elements[0]!;
  const data = element.data ?? {};
  if (element.type === 'pic' && !data.isFlash && !String(data.fileToken ?? '').startsWith('/'))
    return mediaUrl('pic', {
      t: Date.parse(message.createdAt),
      name: String(data.fileName ?? ''),
      token: String(data.fileToken ?? ''),
      orig: String(data.originalUrl ?? ''),
      md5: String(data.md5 ?? ''),
      recv: data.subType === 1 ? 1 : 0,
    });
  if (element.type === 'mface' && data.emojiPackId && data.marketEmoticonIdHex)
    return mediaUrl('mface', {
      pack: String(data.emojiPackId),
      hash: String(data.marketEmoticonIdHex),
    });
  return undefined;
}
