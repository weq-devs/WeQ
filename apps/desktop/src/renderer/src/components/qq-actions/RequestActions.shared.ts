import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh, useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import type { NoticeOperation } from '../../lib/contactNotice';
import { useQQAction } from './shared.shared';

/** 同一弹窗共用两类收件箱，卡片不逐个发起在线读取。 */
export function useNoticeOperations(group: boolean, open: boolean) {
  const a = useQQAction(`requests:${group ? 'group' : 'friend'}`);
  const activity = useQQAutoRefresh(open && a.available);
  const options = group ? { ...activity, retry: false, refetchOnWindowFocus: false } : activity;
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
export function useOnlineNoticeInbox(enabled: boolean, binding: QQWriteBinding | null) {
  const activity = useQQAutoRefresh(enabled && Boolean(binding));
  const options = {
    ...activity,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchInterval: activity.enabled ? 60_000 : false,
  } as const;
  const normal = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: 'friend' },
    options,
  );
  const filtered = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: 'doubtFriend' },
    options,
  );
  const operations = useMemo<NoticeOperation[]>(
    () => [
      ...(normal.data?.operations ?? []).map((r): NoticeOperation => ({ ...r, kind: 'friend' })),
      ...(filtered.data?.operations ?? []).map(
        (r): NoticeOperation => ({ ...r, kind: 'doubtFriend' }),
      ),
    ],
    [normal.data?.operations, filtered.data?.operations],
  );
  return {
    operations,
    error: normal.error?.message || filtered.error?.message,
    ready: normal.isSuccess || filtered.isSuccess,
    readSequence: normal.data?.readSequence,
    canReportRead: enabled && normal.data?.canReportRead === true,
  };
}

type GroupInboxKind = 'group' | 'filteredGroup';

export function useGroupNoticeInbox(enabled: boolean, binding: QQWriteBinding | null) {
  const activity = useQQReadActivity(enabled && Boolean(binding));
  const utils = trpc.useUtils();
  const options = {
    enabled: activity.enabled,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  } as const;
  const normal = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: 'group' },
    options,
  );
  const filtered = trpc.account.qqActions.requestInbox.useQuery(
    { ...binding!, kind: 'filteredGroup' },
    options,
  );
  const operations = useMemo<NoticeOperation[]>(
    () => [
      ...(normal.data?.operations ?? []).map((r): NoticeOperation => ({ ...r, kind: 'group' })),
      ...(filtered.data?.operations ?? []).map(
        (r): NoticeOperation => ({ ...r, kind: 'filteredGroup' }),
      ),
    ],
    [normal.data?.operations, filtered.data?.operations],
  );
  const action = useMutation(
    async ({
      account,
      page,
    }: {
      account: QQWriteBinding;
      page?: { kind: GroupInboxKind; cursor: string };
    }) => {
      if (page) {
        const key = { ...account, kind: page.kind };
        const result = await client.account.qqActions.requestInbox.query({
          ...key,
          cursor: page.cursor,
        });
        utils.account.qqActions.requestInbox.setData(key, (previous) => {
          if (previous?.nextCursor !== page.cursor) return previous;
          const known = new Set(previous.operations.map((row) => row.noticeId));
          return {
            ...previous,
            operations: [
              ...previous.operations,
              ...result.operations.filter((row) => !known.has(row.noticeId)),
            ],
            nextCursor: result.nextCursor,
          };
        });
        return;
      }
      for (const kind of ['group', 'filteredGroup'] as const) {
        const key = { ...account, kind };
        const data = await client.account.qqActions.requestInbox.query({
          ...key,
          manual: kind === 'group',
        });
        utils.account.qqActions.requestInbox.setData(key, data);
      }
    },
  );
  const actionHere =
    action.variables?.account.expectedAccountUin === binding?.expectedAccountUin &&
    action.variables?.account.expectedAccountConfigId === binding?.expectedAccountConfigId;
  const actionError = actionHere ? action.error : undefined;
  const run = (page?: { kind: GroupInboxKind; cursor: string }) => {
    if (activity.enabled && binding && !(actionHere && action.isLoading))
      action.mutate({ account: binding, page });
  };
  const loadMore = (kind: GroupInboxKind, cursor?: string) =>
    activity.enabled && cursor ? () => run({ kind, cursor }) : undefined;

  return {
    operations,
    error:
      actionError instanceof Error
        ? actionError.message
        : normal.error?.message || filtered.error?.message,
    ready: Boolean(normal.data || filtered.data),
    readSequence: normal.data?.readSequence,
    canReportRead:
      activity.enabled && normal.isSuccess && !normal.isFetching && normal.data.canReportRead,
    loading: normal.isFetching || filtered.isFetching || (actionHere && action.isLoading),
    onRefresh: activity.enabled ? () => run() : undefined,
    loadMoreNormal: loadMore('group', normal.data?.nextCursor),
    loadMoreFiltered: loadMore('filteredGroup', filtered.data?.nextCursor),
  };
}
