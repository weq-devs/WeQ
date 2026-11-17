import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import type { NoticeOperation } from '../../lib/contactNotice';
import { useQQAction } from './shared.shared';

/** 同一弹窗共用两类收件箱，卡片不逐个发起在线读取。 */
export function useNoticeOperations(group: boolean, open: boolean) {
  const a = useQQAction(`requests:${group ? 'group' : 'friend'}`);
  const options = useQQAutoRefresh(open && a.available);
  const normal = trpc.account.qqActions.requests.useQuery(
    { ...a.binding!, kind: group ? 'group' : 'friend' },
    options,
  );
  const filtered = trpc.account.qqActions.requests.useQuery(
    { ...a.binding!, kind: group ? 'filteredGroup' : 'doubtFriend' },
    options,
  );
  const operations: NoticeOperation[] = a.available
    ? [
        ...(normal.data ?? []).map((r) => ({
          ...r,
          kind: group ? ('group' as const) : ('friend' as const),
        })),
        ...(filtered.data ?? []).map((r) => ({
          ...r,
          kind: group ? ('filteredGroup' as const) : ('doubtFriend' as const),
        })),
      ]
    : [];
  return { operations, error: normal.error?.message || filtered.error?.message };
}
