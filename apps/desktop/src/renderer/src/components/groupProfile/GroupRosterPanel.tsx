import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import type { inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/router';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { create } from 'zustand';
import { useGroupReadScope, previewMemberView } from '../../hooks/useGroupProfile';
import { GroupInfoPanel } from '../../im-template/template/groupInfoPanel';
import type { GroupMember } from '../../im-template/template/types';
import { displayUserName } from '../../im-template/template/user';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { client } from '../../trpc/client';
import type { GroupMemberWire } from '../../../../main/ipc/serde';
import {
  GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
  GROUP_MEMBER_SORTS,
  compareGroupMemberValues,
  groupMemberCollator,
  groupMemberDefaultDescending,
  isGroupMemberOnlineSort,
  type GroupMemberSort,
  type GroupMemberSortDetail,
} from '../../../../shared/group_member_order';

type FillInput = inferRouterInputs<AppRouter>['account']['fillGroupMemberSort'];
type PanelProps = ComponentProps<typeof GroupInfoPanel>;
type RosterProps = PanelProps & {
  ownerUid?: string;
  mapMember?: (row: GroupMemberWire) => GroupMember;
};
type RosterOrder = { sort: GroupMemberSort; descending: boolean; prioritizeAdmins: boolean };
const defaultOrder: RosterOrder = {
  sort: 'displayName',
  descending: false,
  prioritizeAdmins: GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT,
};
const useRosterOrder = create<Record<string, RosterOrder>>(() => ({}));

export function GroupRosterPanel(props: RosterProps) {
  const { active, binding, key } = useGroupReadScope(!props.conversation.generated);
  const rosterKey = JSON.stringify([
    key,
    props.conversation.id,
    Boolean(props.conversation.generated),
  ]);
  // 搜索和任务状态随群切换重置，排序保留在会话面板之外。
  return (
    <ScopedGroupRosterPanel
      key={rosterKey}
      {...props}
      rosterKey={rosterKey}
      scope={{ active, binding, key }}
    />
  );
}

function ScopedGroupRosterPanel({
  conversation,
  mapMember,
  ownerUid,
  rosterKey,
  scope,
  ...props
}: RosterProps & {
  rosterKey: string;
  scope: Pick<ReturnType<typeof useGroupReadScope>, 'active' | 'binding' | 'key'>;
}) {
  const { active, binding, key } = scope;
  const [visible, setVisible] = useState(false);
  const onVisibilityChange = useCallback((_group: string, value: boolean) => setVisible(value), []);
  const [keyword, setKeyword] = useState('');
  const [needle, setNeedle] = useState('');
  const { sort, descending, prioritizeAdmins } = useRosterOrder(
    (orders) => orders[rosterKey] ?? defaultOrder,
  );
  const changeOrder = (patch: Partial<RosterOrder>) =>
    useRosterOrder.setState((orders) => ({
      [rosterKey]: { ...(orders[rosterKey] ?? defaultOrder), ...patch },
    }));
  const [startedTask, setStartedTask] = useState<{ id: string; sort: GroupMemberSort }>();
  const pendingSearch = !conversation.generated && keyword.trim() !== needle;
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(keyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [keyword]);

  const enabled =
    active &&
    visible &&
    !props.hidden &&
    !props.closing &&
    Boolean(binding) &&
    !conversation.generated;
  const query = useInfiniteQuery({
    ...PROFILE_QUERY_OPTIONS,
    queryKey: [
      'group-member-roster',
      key,
      conversation.id,
      needle,
      sort,
      descending,
      prioritizeAdmins,
    ],
    enabled: enabled && !pendingSearch,
    queryFn: ({ pageParam = 0 }) =>
      client.account.groupMemberRoster.query({
        ...binding!,
        groupCode: conversation.id,
        keyword: needle,
        sort,
        descending,
        prioritizeAdmins,
        limit: 100,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.members.length, 0);
      return last.members.length && loaded < last.total ? loaded : undefined;
    },
    refetchInterval: (data) => (data?.pages[0]?.preparing ? 500 : false),
  });
  const tasks = useQuery({
    queryKey: ['group-member-order-task', key, startedTask?.id],
    queryFn: () =>
      client.backgroundTasks.list.query({
        uin: binding!.expectedAccountUin,
        configId: binding!.expectedAccountConfigId,
      }),
    enabled: enabled && Boolean(startedTask),
    refetchInterval: (data) => {
      const task = data?.find((row) => row.id === startedTask?.id);
      return !task || task.status === 'running' ? 1000 : false;
    },
  });
  const task = tasks.data?.find((row) => row.id === startedTask?.id);
  const fill = useMutation({
    mutationFn: (input: FillInput) => client.account.fillGroupMemberSort.mutate(input),
  });
  const usingTask = startedTask?.sort === sort;
  const fillError = fill.variables?.sort === sort ? fill.error : null;
  const fillErrorMessage =
    fillError instanceof Error ? fillError.message : fillError ? '补取成员资料失败' : undefined;
  const taskRunning = Boolean(usingTask && (!task || task.status === 'running'));
  const taskFinished = Boolean(task && task.status !== 'running');
  const { refetch } = query;
  useEffect(() => {
    if (taskFinished && usingTask) void refetch();
  }, [taskFinished, usingTask, refetch]);
  const generatedMembers = conversation.generated ? conversation.members : undefined;
  const rows = useMemo(() => {
    if (generatedMembers) {
      const matches = generatedMembers.filter((member) =>
        `${displayUserName(member)} ${member.username} ${member.identityValue}`
          .toLowerCase()
          .includes(keyword.trim().toLowerCase()),
      );
      return matches
        .map((member) => {
          const value =
            sort === 'displayName'
              ? displayUserName(member)
              : sort === 'nick'
                ? member.nick?.trim() || null
                : null;
          return {
            member,
            value,
            sortDetail: sort === 'nick' ? { text: value ?? '未读取' } : null,
          };
        })
        .sort(
          (a, b) =>
            compareGroupMemberValues(a.value, b.value, descending) ||
            groupMemberCollator.compare(displayUserName(a.member), displayUserName(b.member)) ||
            a.member.id.localeCompare(b.member.id),
        );
    }
    const result = new Map<
      string,
      {
        member: GroupMember;
        sortDetail: GroupMemberSortDetail | null;
      }
    >();
    const owner = query.data?.pages[0]?.ownerUid ?? ownerUid;
    for (const page of query.data?.pages ?? []) {
      for (const { member: row, displayName, isBot, sortDetail } of page.members) {
        if (result.has(row.uid)) continue;
        const member = mapMember?.(row) ?? previewMemberView(row, owner);
        result.set(row.uid, {
          member: {
            ...member,
            displayName,
            kind: isBot ? 'bot' : member.kind,
            role: owner === row.uid ? 'owner' : member.role,
          },
          sortDetail,
        });
      }
    }
    return [...result.values()];
  }, [generatedMembers, keyword, query.data, mapMember, ownerUid, sort, descending]);
  const visibleRows = pendingSearch ? [] : rows;
  const members = useMemo(() => visibleRows.map((row) => row.member), [visibleRows]);
  const details = useMemo(
    () => new Map(visibleRows.map(({ member, sortDetail }) => [member.id, sortDetail])),
    [visibleRows],
  );
  const onLoadMore = useCallback(() => {
    if (enabled && !pendingSearch && query.hasNextPage && !query.isFetching && !query.isError)
      void query.fetchNextPage({ cancelRefetch: false });
  }, [
    enabled,
    pendingSearch,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
  ]);
  const error = query.error instanceof Error ? query.error.message : null;
  const loading =
    pendingSearch ||
    (!conversation.generated && (!binding || (enabled && query.isFetching && !query.data)));
  const total = pendingSearch ? 0 : (query.data?.pages[0]?.total ?? members.length);
  const setSortField = (field: GroupMemberSort) => {
    fill.reset();
    changeOrder({ sort: field, descending: groupMemberDefaultDescending(field) });
  };

  return (
    <GroupInfoPanel
      {...props}
      conversation={{ ...conversation, members }}
      onMemberVisibilityChange={onVisibilityChange}
      memberSearch={{
        keyword,
        members,
        loading,
        loadingMore: query.isFetchingNextPage,
        total,
        hasMore: Boolean(query.hasNextPage),
        error,
      }}
      onMemberSearchChange={setKeyword}
      onLoadMoreMembers={onLoadMore}
      onLoadMoreSearch={onLoadMore}
      loadingMoreMembers={loading || query.isFetchingNextPage}
      loadingError={error}
      rosterEmpty={query.isSuccess && !keyword.trim() && !members.length}
      onRetryMembers={() => void refetch()}
      memberOrder={{
        options: conversation.generated
          ? { displayName: GROUP_MEMBER_SORTS.displayName, nick: GROUP_MEMBER_SORTS.nick }
          : GROUP_MEMBER_SORTS,
        sort,
        descending,
        details,
        onSort: setSortField,
        onDirection: (descending) => changeOrder({ descending }),
        prioritizeAdmins,
        onPrioritizeAdmins: conversation.generated
          ? undefined
          : (prioritizeAdmins) => changeOrder({ prioritizeAdmins }),
        preparing: query.data?.pages[0]?.preparing,
        fill:
          !conversation.generated && binding && isGroupMemberOnlineSort(sort)
            ? {
                running: taskRunning || fill.isLoading,
                message: fillErrorMessage ?? (usingTask && !taskRunning ? task?.note : undefined),
                failed: Boolean(fillError || (usingTask && task?.status === 'failed')),
                start: () => {
                  fill.mutate(
                    { ...binding, groupCode: conversation.id, sort },
                    { onSuccess: (id) => setStartedTask({ id, sort }) },
                  );
                },
              }
            : undefined,
      }}
    />
  );
}
