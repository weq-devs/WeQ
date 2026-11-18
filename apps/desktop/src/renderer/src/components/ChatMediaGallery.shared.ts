import { createContext, useContext } from 'react';
import { localFileUrl, mediaUrl } from '../lib/resourceUrl';
import { timelineRowKey } from '../../../shared/roaming_timeline';
import type { PreviewMedia } from './mediaPreviewTypes';

export interface GalleryMessage {
  msgId: string;
  msgSeq?: string;
  key?: string;
  source?: 'roaming';
  sourceFormat?: 'native' | 'protocol';
  sendTime: string | number;
  elements: unknown[];
}
export type GalleryOpen = (
  key: string,
  owner: Document,
  clicked?: Partial<PreviewMedia>,
) => boolean;
export const GalleryContext = createContext<GalleryOpen | null>(null);
export const MediaItemKeyContext = createContext('');
export const MediaItemIndexContext = createContext(0);
export const MediaMessageKeyContext = createContext('');
export function useChatMediaOpen() {
  return useContext(GalleryContext);
}

export function galleryMedia(
  messages: GalleryMessage[],
  conv = '',
  kind: 'c2c' | 'group' = 'c2c',
  carrier?: import('../state/messageContext').ForwardCarrier,
): PreviewMedia[] {
  return messages.flatMap((message) => {
    const identity =
      message.key ??
      timelineRowKey({
        ...message,
        msgSeq: message.msgSeq ?? '0',
        sendTime: String(message.sendTime),
      });
    let mediaIndex = 0;
    return message.elements.flatMap((raw): PreviewMedia[] => {
      if (!raw || typeof raw !== 'object') return [];
      const element = raw as { type?: string; data?: Record<string, unknown> };
      if (element.type !== 'pic' && element.type !== 'video') return [];
      const key = `${identity}:${mediaIndex++}`;
      const data = element.data ?? {};
      const token = String(data.fileToken ?? '');
      if (element.type === 'pic' && (data.subType === 1 || data.isFlash || token.startsWith('/')))
        return [];
      const image = element.type === 'pic';
      const t = Number(message.sendTime) * 1000;
      const name = String(data.fileName ?? '');
      const params = {
        t,
        name,
        token,
        ...(image
          ? { lookup: 2, orig: String(data.originalUrl ?? ''), md5: String(data.md5 ?? '') }
          : {
              msgId: carrier?.msgId ?? message.msgId,
              conv,
              ...(carrier ? { fwdMsgId: message.msgId || '', fwdKind: carrier.kind } : {}),
              ...(carrier?.resId ? { fwdResId: carrier.resId } : {}),
            }),
      };
      const proxy = mediaUrl(image ? 'pic' : 'video', params);
      const src =
        String(data.localPreviewUrl || '') ||
        (data.localPath ? localFileUrl(String(data.localPath)) : proxy);
      const ttl = Number(data.fileTTL),
        uploaded = Number(data.uploadTimestamp);
      const width = Number(data.imgWidth) || 0,
        height = Number(data.imgHeight) || 0;
      const md5 = String(data.md5 ?? '');
      return [
        {
          key,
          order: {
            time: Number(message.sendTime),
            messageId: identity,
            rawId: message.msgId,
            sequence: message.msgSeq,
            element: mediaIndex - 1,
          },
          kind: image ? 'image' : 'video',
          src,
          saveSource: src.startsWith('blob:')
            ? data.localPath
              ? { kind: 'url', url: localFileUrl(String(data.localPath)), name }
              : null
            : { kind: 'url', url: src, name },
          title: name || (image ? '聊天图片' : '聊天视频'),
          fallbackSources: src !== proxy ? [proxy] : [],
          poster: image
            ? undefined
            : mediaUrl('video', { t, name, token: String(data.videoToken ?? ''), v: 'thumb' }),
          ocr:
            image && token && width > 0 && height > 0
              ? {
                  peerType: kind,
                  fileToken: token,
                  width,
                  height,
                  md5: /^[0-9a-f]{32}$/i.test(md5) ? md5.toLowerCase() : undefined,
                  fileSize: Number(data.fileSize) || undefined,
                  expiresAt: ttl > 0 && uploaded > 0 ? (ttl + uploaded) * 1000 : undefined,
                }
              : null,
        },
      ];
    });
  });
}
