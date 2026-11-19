import type { Message } from '../im-template/template/types';
import type { MessageMediaTarget } from '../../../shared/message_media';
import type { MediaSaveSource } from '../../../shared/media_save';
import { messageTransferTarget } from '../../../shared/transfer_progress';
import { localFileUrl, localVoiceFileUrl, mediaUrl } from './resourceUrl';
import { messageFavoriteEmojiUrl } from './messageFavoriteEmoji';
import { flashPicUrl } from './cdn';
import type { ForwardCarrier } from '../state/messageContext';
import { cleanNtPath } from '../components/mergeForward/model';

type ElementData = { type?: string; data?: Record<string, unknown> };
const kinds = new Set(['pic', 'video', 'bubbleVideo', 'ptt', 'file', 'mface']);

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
  forward?: { carrier: ForwardCarrier; conv: string },
): MessageMediaTarget | undefined {
  if (target instanceof Element && target.closest('[data-forward-res-id]')) return undefined;
  const elements = (message.qqElements ?? []).filter((element) => kinds.has(element.type ?? ''));
  const key =
    target instanceof Element
      ? target.closest('[data-message-media-key]')?.getAttribute('data-message-media-key')
      : null;
  const element = key
    ? elements.find((item) => messageMediaKey(item) === key)
    : forward && target instanceof HTMLImageElement
      ? undefined
      : elements[0];
  if (!element) return undefined;
  const data = element.data ?? {};
  const name = String(data.fileName ?? '');
  const token = String(data.fileToken ?? '');
  const t = Date.parse(message.createdAt) || 0;
  const kind =
    element.type === 'bubbleVideo'
      ? 'video'
      : element.type === 'pic' && data.subType === 1
        ? 'emoji'
        : (element.type as MessageMediaTarget['kind']);
  const md5 = String(data.md5 ?? '');
  const pack = String(data.emojiPackId ?? '');
  const hash = String(data.marketEmoticonIdHex ?? '');
  const msgId = forward ? forward.carrier.msgId : (message.msgId ?? '');
  const conv = forward?.conv ?? message.conversationId;
  const locator = forward ? { fwdMsgId: message.msgId || '', fwdKind: forward.carrier.kind } : {};
  const fwdResId = forward?.carrier.resId;
  const localPath =
    forward && typeof data.localPath === 'string' ? cleanNtPath(data.localPath) : '';
  const label =
    name ||
    `${{ pic: '图片', emoji: '表情', mface: '表情', video: '视频', ptt: '语音', file: '文件' }[kind]} ${elements.indexOf(element) + 1}`;
  const url =
    kind === 'file'
      ? undefined
      : kind === 'mface'
        ? mediaUrl('mface', { pack, hash })
        : localPath
          ? kind === 'ptt'
            ? localVoiceFileUrl(localPath)
            : localFileUrl(localPath)
          : forward && kind === 'pic' && (data.isFlash || token.startsWith('/'))
            ? (flashPicUrl(token, 0) ?? undefined)
            : mediaUrl(kind === 'emoji' ? 'pic' : kind, {
                t,
                name,
                token,
                md5,
                orig: String(data.originalUrl ?? ''),
                recv: kind === 'emoji' ? 1 : 0,
                ...(kind === 'video' || kind === 'ptt'
                  ? {
                      msgId,
                      conv,
                      ...(forward
                        ? { fwdMsgId: message.msgId || '', fwdKind: forward.carrier.kind }
                        : {}),
                    }
                  : {}),
                ...(fwdResId && (kind === 'video' || kind === 'ptt') ? { fwdResId } : {}),
              });
  const favoriteUrl = messageFavoriteEmojiUrl({ ...message, qqElements: [element] });
  return {
    kind,
    t,
    name,
    token,
    md5,
    msgId,
    conv,
    ...locator,
    ...(fwdResId ? { fwdResId } : {}),
    pack,
    hash,
    url,
    label,
    favoriteUrl,
  };
}

export function messageMediaSaveSource(target: MessageMediaTarget): MediaSaveSource | null {
  if (target.kind === 'file')
    return (target.fwdResId && target.token) ||
      (/^\d+$/.test(target.msgId) && (!target.fwdKind || /^\d+$/.test(target.fwdMsgId ?? '')))
      ? {
          kind: 'chat-file',
          msgId: /^\d+$/.test(target.msgId) ? target.msgId : '0',
          name: target.name,
          token: target.token,
          conv: target.conv,
          ...(target.fwdKind
            ? {
                fwdMsgId: /^\d+$/.test(target.fwdMsgId ?? '') ? target.fwdMsgId : undefined,
                fwdKind: target.fwdKind,
                fwdResId: target.fwdResId,
              }
            : {}),
        }
      : null;
  if (!target.url) return null;
  const progressTarget =
    target.kind === 'pic' || target.kind === 'video'
      ? messageTransferTarget(target.kind, target.msgId, target.token, target.name, target)
      : undefined;
  return {
    kind: 'url',
    url: target.url,
    name: target.name || undefined,
    ...(progressTarget ? { progressTarget } : {}),
  };
}
