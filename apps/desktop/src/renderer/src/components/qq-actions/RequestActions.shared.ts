import { useMemo } from 'react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
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

/** 导航和面板共用在线快照，只有可见工作区定期补读。 */
export function useOnlineNoticeInbox(
  group: boolean,
  enabled: boolean,
  binding: QQWriteBinding | null,
) {
  const activity = useQQAutoRefresh(enabled && Boolean(binding));
  const options = {
    ...activity,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchInterval: activity.enabled ? 60_000 : false,
  } as const;
  const normalKind = group ? 'group' : 'friend';
  const filteredKind = group ? 'filteredGroup' : 'doubtFriend';
  const normal = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: normalKind },
    options,
  );
  const filtered = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: filteredKind },
    options,
  );
  const operations = useMemo<NoticeOperation[]>(
    () => [
      ...(normal.data?.operations ?? []).map((r): NoticeOperation => ({ ...r, kind: normalKind })),
      ...(filtered.data?.operations ?? []).map(
        (r): NoticeOperation => ({ ...r, kind: filteredKind }),
      ),
    ],
    [normal.data?.operations, filtered.data?.operations, normalKind, filteredKind],
  );
  return {
    operations,
    error: normal.error?.message || filtered.error?.message,
    ready: normal.isSuccess || filtered.isSuccess,
    readSequence: normal.data?.readSequence,
    filteredReadSequence: filtered.data?.readSequence,
    canReportRead: enabled && normal.data?.canReportRead === true,
  };
}
