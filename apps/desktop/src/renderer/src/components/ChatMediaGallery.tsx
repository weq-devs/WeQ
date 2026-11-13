import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { client } from '../trpc/client';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { localFileUrl, mediaUrl } from '../lib/resourceUrl';
import { openMediaPreview } from './mediaPreviewStore';
import { timelineRowKey } from '../../../shared/roaming_timeline';
import type { PreviewMedia } from './mediaPreviewTypes';
type GalleryFilter = Parameters<typeof client.account.mediaPreviewPage.query>[0]['filter'];

export interface GalleryMessage {
  msgId: string;
  msgSeq?: string;
  key?: string;
  source?: 'roaming';
  sourceFormat?: 'native' | 'protocol';
  sendTime: string | number;
  elements: unknown[];
}
type GalleryOpen = (key: string, owner: Document, clicked?: Partial<PreviewMedia>) => boolean;
const GalleryContext = createContext<GalleryOpen | null>(null);
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
  carrier?: { msgId: string; kind: 'c2c' | 'group' },
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
              ...(carrier ? { fwdMsgId: message.msgId, fwdKind: carrier.kind } : {}),
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

export function ChatMediaGallery({
  messages,
  children,
  conv = '',
  kind = 'c2c',
  filter,
  carrier,
  paged = false,
  scopeKey = conv,
}: {
  messages: GalleryMessage[];
  children?: ReactNode;
  conv?: string;
  kind?: 'c2c' | 'group';
  filter?: GalleryFilter;
  carrier?: { msgId: string; kind: 'c2c' | 'group' };
  paged?: boolean;
  scopeKey?: string;
}) {
  const policy = useExportSavePolicy();
  const bindingRef = useRef(policy.binding);
  bindingRef.current = policy.binding;
  const identity = `${policy.binding?.expectedAccountConfigId}:${policy.binding?.expectedAccountUin}:${scopeKey}`;
  const handle = useRef<ReturnType<typeof openMediaPreview> | null>(null);
  const items = useMemo(
    () => galleryMedia(messages, conv, kind, carrier),
    [messages, conv, kind, carrier],
  );
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    handle.current?.update(items);
  }, [items]);
  useEffect(
    () => () => {
      handle.current?.close();
      handle.current = null;
    },
    [identity],
  );
  const open = useCallback<GalleryOpen>(
    (key, owner, clicked) => {
      const index = latest.current.findIndex((item) => item.key === key);
      if (index < 0) return false;
      const initial = latest.current.map((item) =>
        item.key === key ? { ...item, ...clicked, key } : item,
      );
      const anchor = initial[index]?.order?.rawId ?? key.slice(0, key.lastIndexOf(':'));
      const cursors: Partial<
        Record<'older' | 'newer', { msgSeq: string; sendTime: string; msgId: string }>
      > = {};
      const binding = bindingRef.current;
      const controller = new AbortController();
      const canPage = paged && Boolean(binding) && /^-?\d+$/.test(anchor);
      handle.current = openMediaPreview({
        items: initial,
        initialKey: key,
        ownerDocument: owner,
        onClose: () => {
          controller.abort();
          handle.current = null;
        },
        hasOlder: canPage,
        hasNewer: canPage,
        prefetchAdjacent: canPage,
        loadPage:
          canPage && binding
            ? async (direction) => {
                const page = await client.account.mediaPreviewPage.query(
                  {
                    ...binding,
                    kind,
                    conv,
                    filter: filter ?? {},
                    direction,
                    anchorMsgId: anchor,
                    anchorTime: initial[index]?.order?.time,
                    anchorSeq: initial[index]?.order?.sequence,
                    cursor: cursors[direction],
                  },
                  { signal: controller.signal },
                );
                cursors[direction] = page.cursor;
                const ordered = direction === 'older' ? [...page.items].reverse() : page.items;
                return { items: galleryMedia(ordered, conv, kind), hasMore: page.hasMore };
              }
            : undefined,
      });
      return true;
    },
    [conv, kind, paged, filter, identity],
  );
  return <GalleryContext.Provider value={open}>{children}</GalleryContext.Provider>;
}
