import { useCallback, useEffect, useRef, useState } from 'react';
import { getQueryKey } from '@trpc/react-query';
import { replaceEqualDeep, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { client, trpc } from '../trpc/client';
import { patchRecentContactRows, recentContactPreviewIsBehind } from '../lib/recentContacts';
import { createUnreadTargetRefresh } from '../lib/unreadRefresh';
import { RECENT_DIRECTORY_SIZE, recentContactHeadOptions } from './useRecentContactQueries';
import type { QQWriteBinding } from './useQQWriteSession';
import { queryInputBatches } from '../lib/queryInputBatches';
import { IS_WEB } from '../lib/target.shared';

type Page = Awaited<ReturnType<typeof client.account.listRecentContacts.query>>;
type Contact = Page['items'][number];
const EMPTY_PREVIEWS: ReadonlyMap<string, Contact> = new Map();
const RECENT_PREVIEW_LIMIT = 128;

/** 可见旧行与实时变更按目标读取小表，不等待完整目录或逐会话查正文。 */
export function useRecentContactTargets(
  binding: QQWriteBinding | null,
  active: boolean,
  visibleIds: readonly string[],
) {
  const cache = useQueryClient();
  const uin = binding?.expectedAccountUin ?? '';
  const configId = binding?.expectedAccountConfigId ?? '';
  const scope = JSON.stringify([uin, configId]);
  const visible = useRef(visibleIds);
  visible.current = visibleIds;
  const [previews, setPreviews] = useState<{ scope: string; rows: ReadonlyMap<string, Contact> }>();
  useEffect(
    () => setPreviews((previous) => (previous?.scope === scope ? previous : undefined)),
    [scope],
  );
  const current = useRef<{
    scope: string;
    queue: ReturnType<typeof createUnreadTargetRefresh>;
    visibleIds: ReadonlySet<string>;
    assistantPreview?: string;
  } | null>(null);
  useEffect(() => {
    if (!uin || !configId || !active) return;
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId };
    const headKey = recentContactHeadOptions(binding).queryKey;
    const directoryKey = getQueryKey(
      trpc.account.listRecentContacts,
      { ...binding, limit: RECENT_DIRECTORY_SIZE },
      'infinite',
    );
    let stopped = false;
    const patch = (page: Page, rows: Page['items']): Page => {
      const items = patchRecentContactRows(page.items, rows);
      return items === page.items ? page : { ...page, items };
    };
    const queue = createUnreadTargetRefresh(
      async (targets) => {
        const batches = queryInputBatches(
          'account.listRecentContactTargets',
          targets,
          (batch) => ({
            ...binding,
            targetUids: batch.map((target) => target.uid),
            ...(!IS_WEB ? { includeSentPreview: true } : {}),
          }),
          IS_WEB,
          256,
        );
        for (const input of batches) {
          if (stopped) return true;
          const rows = await client.account.listRecentContactTargets.query(input);
          if (stopped) return true;
          if (!rows.length) continue;
          cache.setQueryData<Page>(headKey, (page) => (page ? patch(page, rows) : page));
          cache.setQueryData<InfiniteData<Page>>(directoryKey, (directory) =>
            directory
              ? { ...directory, pages: directory.pages.map((page) => patch(page, rows)) }
              : directory,
          );
          if (!IS_WEB) {
            const protectedIds = new Set(visible.current);
            if (current.current?.assistantPreview)
              protectedIds.add(current.current.assistantPreview);
            const displayed = rows.filter((row) => protectedIds.has(row.targetUid));
            if (displayed.length)
              setPreviews((previous) => {
                const currentRows = previous?.scope === scope ? previous.rows : EMPTY_PREVIEWS;
                let next: Map<string, Contact> | undefined;
                for (const row of displayed) {
                  const old = (next ?? currentRows).get(row.targetUid);
                  if (old && recentContactPreviewIsBehind(row, old)) continue;
                  const updated = replaceEqualDeep(old, row);
                  if (updated === old) continue;
                  next ??= new Map(currentRows);
                  next.delete(row.targetUid);
                  next.set(row.targetUid, updated);
                }
                if (!next) return previous;
                for (const id of next.keys()) {
                  if (next.size <= RECENT_PREVIEW_LIMIT) break;
                  if (!protectedIds.has(id)) next.delete(id);
                }
                return { scope, rows: next };
              });
          }
        }
        return true;
      },
      undefined,
      256,
      500,
    );
    current.current = { scope, queue, visibleIds: new Set() };
    return () => {
      stopped = true;
      queue.dispose();
      if (current.current?.queue === queue) current.current = null;
    };
  }, [uin, configId, scope, active, cache]);
  const refresh = useCallback(
    (ids?: readonly string[]) => {
      if (current.current?.scope !== scope) return;
      current.current.queue.request((ids ?? visible.current).map((uid) => ({ chatType: 0, uid })));
    },
    [scope],
  );
  const setAssistantPreview = useCallback(
    (id: string | undefined) => {
      const observer = current.current;
      if (!active || observer?.scope !== scope || observer.assistantPreview === id) return;
      observer.assistantPreview = id;
      if (id) observer.queue.request([{ chatType: 0, uid: id }], false);
    },
    [active, scope],
  );
  useEffect(() => {
    const observer = current.current;
    if (!active || observer?.scope !== scope) return;
    const next = new Set(visibleIds);
    const entered = [...next].filter((uid) => !observer.visibleIds.has(uid));
    observer.visibleIds = next;
    // 滚动只校准新进入视口的行；实时事件和重连仍主动校准受影响的行。
    if (entered.length)
      observer.queue.request(
        entered.map((uid) => ({ chatType: 0, uid })),
        false,
      );
  }, [active, visibleIds, scope, cache]);
  return {
    refresh,
    previewRows: previews?.scope === scope ? previews.rows : EMPTY_PREVIEWS,
    setAssistantPreview,
  };
}
