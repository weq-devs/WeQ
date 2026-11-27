import { useEffect, useMemo, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh, useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { groupNoticeReadId, type NoticeOperation } from '../../lib/contactNotice';
import { createUnreadTargetRefresh } from '../../lib/unreadRefresh';
import type { GroupJoinRequest } from '../../im-template/template/types';
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

/** 群通知页只在对应收件箱出现新待审批申请后补读。 */
function usePendingGroupInboxRefresh(
  visible: boolean,
  binding: QQWriteBinding | null,
  localNotices: readonly GroupJoinRequest[] | undefined,
  operations: readonly NoticeOperation[],
  selfUid: string | undefined,
) {
  const utils = trpc.useUtils();
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  type Box = { chatType: 2; uid: GroupInboxKind };
  const refresh = useRef<ReturnType<typeof createUnreadTargetRefresh<Box>> | undefined>(undefined);
  const previous = useRef<
    | {
        uin?: string;
        configId?: string;
        ids: Set<string>;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!visible || !uin || !configId) return;
    const queue = createUnreadTargetRefresh<Box>(
      async (boxes) => {
        await Promise.allSettled(
          boxes.map(({ uid: kind }) =>
            utils.account.qqActions.requestInbox.invalidate(
              { expectedAccountUin: uin, expectedAccountConfigId: configId, kind },
              { exact: true },
              { cancelRefetch: false },
            ),
          ),
        );
        return true;
      },
      undefined,
      2,
      5000,
    );
    refresh.current = queue;
    return () => {
      refresh.current = undefined;
      queue.dispose();
    };
  }, [visible, uin, configId, utils]);

  useEffect(() => {
    if (!visible || !localNotices) {
      previous.current = undefined;
      return;
    }
    const pending = localNotices.filter(
      (notice) =>
        notice.action === '申请加入' &&
        notice.handleState === 'pending' &&
        !(selfUid && notice.user.id === selfUid) &&
        !(uin && notice.user.identityLabel === 'QQ' && notice.user.identityValue === uin),
    );
    const before = previous.current;
    previous.current = { uin, configId, ids: new Set(pending.map(groupNoticeReadId)) };
    if (!before || before.uin !== uin || before.configId !== configId) return;
    const known = new Set(operations.map((operation) => operation.noticeId));
    const changes = new Set<GroupInboxKind>();
    for (const notice of pending) {
      const id = groupNoticeReadId(notice);
      if (!before.ids.has(id) && !known.has(id))
        changes.add(notice.isDoubt ? 'filteredGroup' : 'group');
    }
    refresh.current?.request([...changes].map((uid) => ({ chatType: 2, uid })));
  }, [visible, uin, configId, localNotices, operations, selfUid]);
}

export function useGroupNoticeInbox(
  enabled: boolean,
  binding: QQWriteBinding | null,
  localNotices?: readonly GroupJoinRequest[],
  selfUid?: string,
) {
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
  const operations = useMemo<NoticeOperation[]>(() => {
    const handled = new Set(
      (localNotices ?? [])
        .filter((notice) => notice.handleState === 'agreed' || notice.handleState === 'refused')
        .map(groupNoticeReadId),
    );
    const pending = [
      ...(normal.data?.operations ?? []).map((r): NoticeOperation => ({ ...r, kind: 'group' })),
      ...(filtered.data?.operations ?? []).map(
        (r): NoticeOperation => ({ ...r, kind: 'filteredGroup' }),
      ),
    ];
    return pending.filter(({ noticeId }) => !noticeId || !handled.has(noticeId));
  }, [normal.data?.operations, filtered.data?.operations, localNotices]);
  usePendingGroupInboxRefresh(activity.enabled, binding, localNotices, operations, selfUid);
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
      const errors: unknown[] = [];
      for (const kind of ['group', 'filteredGroup'] as const) {
        const key = { ...account, kind };
        try {
          const data = await client.account.qqActions.requestInbox.query({
            ...key,
            manual: kind === 'group',
          });
          utils.account.qqActions.requestInbox.setData(key, data);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
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
