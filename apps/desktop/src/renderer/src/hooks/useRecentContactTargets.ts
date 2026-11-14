import { useCallback, useEffect, useRef } from 'react';
import { getQueryKey } from '@trpc/react-query';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { client, trpc } from '../trpc/client';
import { patchRecentContactRows } from '../lib/recentContacts';
import { createUnreadTargetRefresh } from '../lib/unreadRefresh';
import { RECENT_DIRECTORY_SIZE, recentContactHeadOptions } from './useRecentContactQueries';
import type { QQWriteBinding } from './useQQWriteSession';
import { queryInputBatches } from '../lib/queryInputBatches';
import { IS_WEB } from '../lib/target';

type Page = Awaited<ReturnType<typeof client.account.listRecentContacts.query>>;

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
  const current = useRef<{
    scope: string;
    queue: ReturnType<typeof createUnreadTargetRefresh>;
  } | null>(null);
  useEffect(() => {
    if (!uin || !configId || !active) return;
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId };
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
          }),
          IS_WEB,
          256,
        );
        for (const input of batches) {
          if (stopped) return true;
          const rows = await client.account.listRecentContactTargets.query(input);
          if (stopped) return true;
          cache.setQueryData<Page>(recentContactHeadOptions(binding).queryKey, (page) =>
            page ? patch(page, rows) : page,
          );
          cache.setQueryData<InfiniteData<Page>>(
            getQueryKey(
              trpc.account.listRecentContacts,
              { ...binding, limit: RECENT_DIRECTORY_SIZE },
              'infinite',
            ),
            (directory) =>
              directory
                ? { ...directory, pages: directory.pages.map((page) => patch(page, rows)) }
                : directory,
          );
        }
        return true;
      },
      undefined,
      256,
      500,
    );
    current.current = { scope, queue };
    return () => {
      stopped = true;
      queue.dispose();
      if (current.current?.queue === queue) current.current = null;
    };
  }, [uin, configId, scope, active, cache]);
  const refresh = useCallback(
    (ids?: readonly string[], repeatInFlight = true) => {
      if (current.current?.scope !== scope) return;
      current.current.queue.request(
        (ids ?? visible.current).map((uid) => ({ chatType: 0, uid })),
        repeatInFlight,
      );
    },
    [scope],
  );
  useEffect(() => {
    if (active) refresh(visibleIds, false);
  }, [active, visibleIds, refresh]);
  return refresh;
}
