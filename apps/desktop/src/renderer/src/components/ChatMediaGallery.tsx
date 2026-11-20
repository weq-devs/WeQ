import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { client } from '../trpc/client';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { openMediaPreview } from './mediaPreviewStore.shared';
import {
  type GalleryMessage,
  galleryMedia,
  type GalleryOpen,
  GalleryContext,
  GalleryItemsContext,
} from './ChatMediaGallery.shared';

type GalleryFilter = Parameters<typeof client.account.mediaPreviewPage.query>[0]['filter'];

export function ChatMediaGallery({
  messages,
  children,
  conv = '',
  kind = 'c2c',
  filter,
  mediaKind,
  carrier,
  paged = false,
  scopeKey = conv,
}: {
  messages: GalleryMessage[];
  children?: ReactNode;
  conv?: string;
  kind?: 'c2c' | 'group';
  filter?: GalleryFilter;
  mediaKind?: 'image' | 'video';
  carrier?: import('../state/messageContext').ForwardCarrier;
  paged?: boolean;
  scopeKey?: string;
}) {
  const policy = useExportSavePolicy();
  const bindingRef = useRef(policy.binding);
  bindingRef.current = policy.binding;
  const identity = `${policy.binding?.expectedAccountConfigId}:${policy.binding?.expectedAccountUin}:${scopeKey}`;
  const handle = useRef<ReturnType<typeof openMediaPreview> | null>(null);
  const mediaFor = useCallback(
    (rows: GalleryMessage[]) => {
      const all = galleryMedia(rows, conv, kind, carrier);
      return mediaKind ? all.filter((item) => item.kind === mediaKind) : all;
    },
    [conv, kind, carrier, mediaKind],
  );
  const items = useMemo(() => mediaFor(messages), [messages, mediaFor]);
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
                return { items: mediaFor(ordered), hasMore: page.hasMore };
              }
            : undefined,
      });
      return true;
    },
    [conv, kind, paged, filter, identity, mediaFor],
  );
  return (
    <GalleryContext.Provider value={open}>
      <GalleryItemsContext.Provider value={items}>{children}</GalleryItemsContext.Provider>
    </GalleryContext.Provider>
  );
}
export type { GalleryMessage } from './ChatMediaGallery.shared';
