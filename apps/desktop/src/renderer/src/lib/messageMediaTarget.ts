import type { Message } from '../im-template/template/types';
import type { MessageMediaTarget } from '../../../shared/message_media';
import type { MediaSaveSource } from '../../../shared/media_save';
import { mediaUrl } from './resourceUrl';
import { messageFavoriteEmojiUrl } from './messageFavoriteEmoji';

type ElementData = { type?: string; data?: Record<string, unknown> };
const kinds = new Set(['pic', 'video', 'ptt', 'file', 'mface']);

export function messageMediaKey(element: ElementData): string {
  const data = element.data ?? {};
  return JSON.stringify(
    [element.type, data.fileName, data.fileToken, data.emojiPackId, data.marketEmoticonIdHex].map(
      (value) => String(value ?? ''),
    ),
  );
}

export function messageMediaTarget(
  message: Message,
  target?: EventTarget | null,
): MessageMediaTarget | undefined {
  const elements = (message.qqElements ?? []).filter((element) => kinds.has(element.type ?? ''));
  const key =
    target instanceof Element
      ? target.closest('[data-message-media-key]')?.getAttribute('data-message-media-key')
      : null;
  const element = key ? elements.find((item) => messageMediaKey(item) === key) : elements[0];
  if (!element) return undefined;
  const data = element.data ?? {};
  const name = String(data.fileName ?? '');
  const token = String(data.fileToken ?? '');
  const t = Date.parse(message.createdAt) || 0;
  const kind =
    element.type === 'pic' && data.subType === 1
      ? 'emoji'
      : (element.type as MessageMediaTarget['kind']);
  const md5 = String(data.md5 ?? '');
  const pack = String(data.emojiPackId ?? '');
  const hash = String(data.marketEmoticonIdHex ?? '');
  const label =
    name ||
    `${{ pic: '图片', emoji: '表情', mface: '表情', video: '视频', ptt: '语音', file: '文件' }[kind]} ${elements.indexOf(element) + 1}`;
  const url =
    kind === 'file'
      ? undefined
      : kind === 'mface'
        ? mediaUrl('mface', { pack, hash })
        : mediaUrl(kind === 'emoji' ? 'pic' : kind, {
            t,
            name,
            token,
            md5,
            orig: String(data.originalUrl ?? ''),
            recv: kind === 'emoji' ? 1 : 0,
          });
  const favoriteUrl = messageFavoriteEmojiUrl({ ...message, qqElements: [element] });
  return {
    kind,
    t,
    name,
    token,
    md5,
    msgId: message.msgId ?? '',
    conv: message.conversationId,
    pack,
    hash,
    url,
    label,
    favoriteUrl,
  };
}

export function messageMediaSaveSource(target: MessageMediaTarget): MediaSaveSource | null {
  if (target.kind === 'file')
    return /^\d+$/.test(target.msgId)
      ? {
          kind: 'chat-file',
          msgId: target.msgId,
          name: target.name,
          token: target.token,
          conv: target.conv,
        }
      : null;
  return target.url ? { kind: 'url', url: target.url, name: target.name || undefined } : null;
}
