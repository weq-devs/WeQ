import type { QueryClient, QueryFilters } from '@tanstack/react-query';
import { PROFILE_QUERY_OPTIONS } from './profileQuery';

const GROUP_MEMBER_PAGE_SIZE = 120;

export function groupMemberPagesKey(scope: string, groupCode?: string) {
  return groupCode === undefined
    ? (['chat-group-members', scope] as const)
    : (['chat-group-members', scope, groupCode] as const);
}

export function groupMemberPagesOptions<T>(
  scope: string,
  groupCode: string,
  load: (offset: number, limit: number) => Promise<T[]>,
) {
  return {
    ...PROFILE_QUERY_OPTIONS,
    queryKey: groupMemberPagesKey(scope, groupCode),
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) => load(pageParam, GROUP_MEMBER_PAGE_SIZE),
    // 展示层去重不改变数据库偏移；否则一整页重复 UID 会卡在同一个 offset。
    getNextPageParam: (last: T[], pages: T[][]) =>
      last.length === GROUP_MEMBER_PAGE_SIZE
        ? pages.reduce((offset, page) => offset + page.length, 0)
        : undefined,
  };
}

const groupInfoProcedures = new Set([
  'account.getGroupDetail',
  'account.getGroupExt',
  'account.getGroupMemberLevelInfo',
  'account.listGroupLeftMembers',
  'account.listGroupMembersByLevel',
  'account.groupMemberPreview',
  'account.qqWrite.memberDetails',
  'account.qqWrite.memberState',
  'account.qqActions.groupPermissions',
]);

export function groupInfoQueries(
  client: QueryClient,
  scope: string,
  binding: { expectedAccountUin: string; expectedAccountConfigId: string },
) {
  const cardScope = `${binding.expectedAccountUin}:${binding.expectedAccountConfigId}`;
  const groupOf = ([path, options, id]: readonly unknown[]): string | undefined => {
    if (path === 'chat-group-members' || path === 'group-card-member-list') {
      const owner = path === 'chat-group-members' ? scope : cardScope;
      return options === owner && typeof id === 'string' && id ? id : undefined;
    }
    if (!Array.isArray(path) || !groupInfoProcedures.has(path.join('.'))) return undefined;
    const input = (options as { input?: Record<string, unknown> } | undefined)?.input;
    if (
      !input ||
      (input.expectedAccountUin !== undefined &&
        input.expectedAccountUin !== binding.expectedAccountUin) ||
      (input.expectedAccountConfigId !== undefined &&
        input.expectedAccountConfigId !== binding.expectedAccountConfigId)
    )
      return undefined;
    if (typeof input.groupCode === 'string' && input.groupCode) return input.groupCode;
    if (typeof input.groupId === 'number' && input.groupId > 0) return String(input.groupId);
    return undefined;
  };
  return {
    activeGroups() {
      const groups = new Set<string>();
      for (const { queryKey } of client.getQueryCache().findAll({ type: 'active' })) {
        const group = groupOf(queryKey);
        if (group) groups.add(group);
      }
      return groups;
    },
    async refresh(groups: ReadonlySet<string>) {
      if (!groups.size) return;
      const filters = {
        predicate: ({ queryKey }: { queryKey: readonly unknown[] }) => {
          const group = groupOf(queryKey);
          return group !== undefined && groups.has(group);
        },
      };
      // 保留现有分页，取消变更前发出的读，防止旧结果最后到达。
      await client.cancelQueries(filters);
      await client.invalidateQueries(filters);
    },
    async staleInactive() {
      const filters: QueryFilters = {
        type: 'inactive',
        predicate: ({ queryKey }) => groupOf(queryKey) !== undefined,
      };
      await client.cancelQueries(filters);
      await client.invalidateQueries({ ...filters, refetchType: 'none' });
    },
  };
}

export type GroupMemberLookup<T> = (input: { groupCode: string; uids: string[] }) => Promise<T[]>;

/** 同一账号的聊天与列表只共享在途读取；完成即释放，失效后不复用旧查询。 */
export function createGroupMemberLookup<T extends { uid: string }>(read: GroupMemberLookup<T>) {
  const pending = new Map<string, Map<string, Promise<T | undefined>>>();
  const load: GroupMemberLookup<T> = async ({ groupCode, uids }) => {
    if (!uids.length) return [];
    let group = pending.get(groupCode);
    if (!group) {
      group = new Map();
      pending.set(groupCode, group);
    }
    const current = group;
    const unique = [...new Set(uids)];
    const missing = unique.filter((uid) => !current.has(uid));
    if (missing.length) {
      const batch = Promise.resolve()
        .then(() => read({ groupCode, uids: missing }))
        .then((rows) => new Map(rows.map((row) => [row.uid, row])));
      for (const uid of missing) {
        const result = batch.then((rows) => rows.get(uid));
        current.set(uid, result);
        const release = () => {
          if (current.get(uid) === result) current.delete(uid);
          if (!current.size && pending.get(groupCode) === current) pending.delete(groupCode);
        };
        void result.then(release, release);
      }
    }
    const rows = await Promise.all(unique.map((uid) => current.get(uid)!));
    return rows.filter((row) => row !== undefined);
  };
  return {
    load,
    invalidate(groupCode?: string) {
      if (groupCode === undefined) pending.clear();
      else pending.delete(groupCode);
    },
  };
}

/** 退群成员仍用于历史发言人的名片解析，不再放回当前群成员列表。 */
export function activeGroupMembers<T extends { memberFlag?: number }>(members: readonly T[]): T[] {
  return members.filter((member) => member.memberFlag !== 1);
}
