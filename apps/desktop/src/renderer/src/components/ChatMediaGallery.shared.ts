import { createContext, useContext } from 'react';
import { localFileUrl, mediaUrl } from '../lib/resourceUrl';
import { timelineRowKey } from '../../../shared/roaming_timeline';
import type { PreviewMedia } from './mediaPreviewTypes';
import { mediaTransferTarget, messageTransferTarget } from '../../../shared/transfer_progress';
import { isChatVideoAttachment, isMovFileName } from '@weq/service/message-filter';
import type { MediaSaveSource } from '../../../shared/media_save';
import { isChatGalleryImage } from '../lib/chatMediaSize';
import { cleanNtPath } from './mergeForward/model';

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
export const GalleryItemsContext = createContext<readonly PreviewMedia[]>([]);
export const MediaItemKeyContext = createContext('');
export const MediaItemIndexContext = createContext(0);
export const MediaMessageKeyContext = createContext('');
export const MediaBrowseContext = createContext(false);
export function useChatMediaOpen() {
  return useContext(GalleryContext);
}

export function useChatMediaItems() {
  return useContext(GalleryItemsContext);
}

export function chatImageLocalPath(data: Record<string, unknown>) {
  return cleanNtPath(
    (typeof data.localPath === 'string' && data.localPath) ||
      (typeof data.filePath === 'string' && data.filePath) ||
      '',
  );
}

export function chatImagePreviewSources(
  data: Record<string, unknown>,
  params: Record<string, string | number>,
  browseThumbnail = false,
): Pick<PreviewMedia, 'src' | 'originalImage'> | undefined {
  if (data.localPreviewUrl || (!params.token && !params.name && !params.md5)) return undefined;
  const localPath = chatImageLocalPath(data);
  const bytes = Number(data.fileSize);
  const original = { ...params, v: 'original', intent: 'interactive' };
  return {
    src: mediaUrl('pic', {
      ...params,
      v: 'thumb',
      ...(browseThumbnail ? { intent: 'interactive' } : { preview: 1 }),
    }),
    originalImage: {
      localSrc: localPath ? localFileUrl(localPath) : undefined,
      cachedSrc: mediaUrl('pic', { ...original, localOnly: 1 }),
      src: mediaUrl('pic', original),
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined,
    },
  };
}

/** 本端 Blob 只用于显示，已回读的图片仍通过原有保存管线获取 QQ 原图。 */
export function chatBlobImageSaveSource(
  src: string,
  params: Record<string, string | number>,
): PreviewMedia['saveSource'] {
  if (!src.startsWith('blob:') || !params.token) return undefined;
  return {
    kind: 'url',
    url: mediaUrl('pic', { ...params, v: 'original', intent: 'interactive' }),
    name: String(params.name || ''),
  };
}

type ChatFileSource = Extract<MediaSaveSource, { kind: 'chat-file' }>;

export function chatFileSaveSource({
  fwdMsgId,
  ...source
}: Omit<ChatFileSource, 'kind'>): ChatFileSource {
  return {
    ...source,
    kind: 'chat-file',
    msgId: source.fwdKind && !/^\d+$/.test(source.msgId) ? '0' : source.msgId,
    fwdMsgId: fwdMsgId && /^\d+$/.test(fwdMsgId) ? fwdMsgId : undefined,
  };
}

export type ChatVideoAttachment = Pick<PreviewMedia, 'src' | 'progressTarget'> & {
  saveSource: MediaSaveSource;
};

export function chatVideoAttachment(
  data: Record<string, unknown>,
  identity: Pick<ChatFileSource, 'msgId' | 'conv' | 'fwdMsgId' | 'fwdKind' | 'fwdResId'>,
): ChatVideoAttachment | undefined {
  const { fileName: name } = data;
  if (!isMovFileName(name)) return undefined;
  const path =
    !identity.msgId && !identity.fwdResId && typeof data.localPath === 'string' && data.localPath;
  if (path) {
    const src = localFileUrl(path);
    const saveSource: MediaSaveSource = { kind: 'url', url: src, name };
    return { src, saveSource, progressTarget: mediaTransferTarget(saveSource) };
  }
  const token = typeof data.fileToken === 'string' ? data.fileToken : '';
  const saveSource = chatFileSaveSource({ ...identity, name, token });
  if (!/^\d{1,20}$/.test(saveSource.msgId)) return undefined;
  const { msgId, conv, fwdMsgId, fwdKind, fwdResId } = saveSource;
  const src = mediaUrl('file', {
    name,
    token,
    msgId,
    ...(conv ? { conv } : {}),
    ...(fwdMsgId ? { fwdMsgId } : {}),
    ...(fwdKind ? { fwdKind } : {}),
    ...(fwdResId ? { fwdResId } : {}),
  });
  return { src, saveSource, progressTarget: mediaTransferTarget(saveSource) };
}

export function galleryMedia(
  messages: GalleryMessage[],
  conv = '',
  kind: 'c2c' | 'group' = 'c2c',
  carrier?: import('../state/messageContext').ForwardCarrier,
  browseThumbnails = false,
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
      const attachment = isChatVideoAttachment(element);
      if (element.type !== 'pic' && element.type !== 'video' && !attachment) return [];
      const key = `${identity}:${mediaIndex++}`;
      const data = element.data ?? {};
      const order = {
        time: Number(message.sendTime),
        messageId: identity,
        rawId: message.msgId,
        sequence: message.msgSeq,
        element: mediaIndex - 1,
      };
      if (attachment) {
        const video = chatVideoAttachment(data, {
          msgId: carrier?.msgId ?? message.msgId,
          conv: carrier || kind === 'group' ? conv : '',
          ...(carrier
            ? { fwdMsgId: message.msgId, fwdKind: carrier.kind, fwdResId: carrier.resId }
            : {}),
        });
        return video ? [{ key, order, kind: 'video', title: String(data.fileName), ...video }] : [];
      }
      const token = String(data.fileToken ?? '');
      if (element.type === 'pic' && !isChatGalleryImage(data)) return [];
      const image = element.type === 'pic';
      const t = Number(message.sendTime) * 1000;
      const name = String(data.fileName ?? '');
      const params = {
        t,
        name,
        token,
        ...(image
          ? {
              lookup: 2,
              orig: String(data.originalUrl ?? ''),
              small: String(data.thumbnailUrl ?? ''),
              md5: String(data.md5 ?? ''),
            }
          : {
              msgId: carrier?.msgId ?? message.msgId,
              conv,
              ...(carrier ? { fwdMsgId: message.msgId || '', fwdKind: carrier.kind } : {}),
              ...(carrier?.resId ? { fwdResId: carrier.resId } : {}),
            }),
      };
      const proxy = mediaUrl(image ? 'pic' : 'video', params);
      const preview = image ? chatImagePreviewSources(data, params, browseThumbnails) : undefined;
      const localPath = image ? chatImageLocalPath(data) : String(data.localPath || '');
      const src =
        String(data.localPreviewUrl || '') ||
        (preview?.src ?? (localPath ? localFileUrl(localPath) : proxy));
      const ttl = Number(data.fileTTL),
        uploaded = Number(data.uploadTimestamp);
      const width = Number(data.imgWidth) || 0,
        height = Number(data.imgHeight) || 0;
      const md5 = String(data.md5 ?? '');
      return [
        {
          key,
          order,
          kind: image ? 'image' : 'video',
          progressTarget: messageTransferTarget(
            image ? 'pic' : 'video',
            carrier?.msgId ?? message.msgId,
            token,
            name,
            carrier ? { fwdMsgId: message.msgId, fwdResId: carrier.resId } : undefined,
          ),
          src,
          originalImage: preview?.originalImage,
          saveSource: preview
            ? undefined
            : src.startsWith('blob:')
              ? data.localPath
                ? { kind: 'url', url: localFileUrl(String(data.localPath)), name }
                : ((image ? chatBlobImageSaveSource(src, params) : undefined) ?? null)
              : { kind: 'url', url: src, name },
          title: name || (image ? '聊天图片' : '聊天视频'),
          fallbackSources: !preview && src !== proxy ? [proxy] : [],
          poster: image
            ? undefined
            : mediaUrl('video', {
                t,
                name,
                token: String(data.videoToken ?? ''),
                v: 'thumb',
                ...(browseThumbnails ? { intent: 'interactive' } : {}),
              }),
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
