import { useQuery } from '@tanstack/react-query';
const calls: string[] = [];
const preferences = { epoch: 'fixture', revision: 0, values: {}, records: {} };
let groupName = '原来的群名称';
Object.assign(window, { groupCardCalls: calls });
const row = (n: number) => ({
  uid: `u_member${n}`,
  uin: String(10000 + n),
  card: `成员 ${n}`,
  nick: `昵称 ${n}`,
  joinTime: 1700000000,
  lastSpeakTime: 0,
  muteUntil: 0,
  adminFlag: 0,
  memberFlag: 0,
  customTitle: '',
  memberLevel: 1,
});
async function reply(path: string, input) {
  calls.push(path);
  if (path === 'clientState.patch') {
    preferences.revision++;
    Object.assign(preferences.values, input);
    return structuredClone(preferences);
  }
  if (path === 'account.getAccountConfig') return { uin: '99999', configId: 'fixture' };
  if (path === 'bootstrap.getSettings') return {};
  if (path === 'account.getGroupAlbumAccessState')
    return {
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ssoReady: true,
      source: { expectedAccountUin: '99999', expectedAccountConfigId: 'fixture' },
    };
  if (path === 'account.getGroupDetail') return null;
  if (path === 'account.qqWrite.peerState')
    return { role: 'admin', groupName, remark: '我的群备注' };
  if (path === 'account.qqWrite.groupName') {
    groupName = input.name;
    return { state: 'confirmed' };
  }
  if (path === 'account.groupMemberPreview') {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      members: Array.from({ length: 8 }, (_, i) => row(i + 1)),
      source: 'local',
      partial: true,
      error: null,
    };
  }
  if (path === 'account.contactMetrics.snapshot')
    return {
      rows: {
        '12345': {},
        'group:12345': {
          friendCount: {
            value: 0,
            updatedAt: 1794380000000,
            attemptedAt: 1794380000000,
            state: 'ready',
          },
        },
      },
    };
  if (path === 'account.getGroupExtendedProfile')
    return {
      groupId: 12345,
      profile: {
        grade: 4,
        activeMemberCount: 105,
        freezeState: 0,
        freezeReason: 0,
        portraitSequence: 6,
        portrait: { count: 1, defaultId: 6, pictures: [] },
      },
      source: 'cache',
      updatedAt: 1794380000000,
      error: null,
    };
  if (path === 'account.listGroupMembers')
    return input.offset ? [] : Array.from({ length: 10 }, (_, i) => row(i + 1));
  if (path === 'account.searchGroupMembers') return { members: [row(3)], total: 1 };
  if (path === 'account.getGroupEssencePageWithContent') return { complete: true, messages: [] };
  if (path === 'account.qqActions.groupReadTools')
    return { signed: [], atAll: { canAtAll: false, remainCountForUin: 0, remainCountForGroup: 0 } };
  if (path === 'account.contactMetrics.history.status')
    return { migrating: false, migrationErrors: [], lastError: null };
  if (path === 'account.contactMetrics.history.list') return { rows: [], hasMore: false };
  if (path === 'account.getProfile' || path === 'account.getProfileByUin') return null;
  if (path === 'account.qqWrite.commonRelationships') return { friendCount: 0, groups: [] };
  if (path === 'account.dressup.peerStats') return { level: 10, likeCount: 0 };
  if (path === 'account.dressup.peerHome' || path === 'account.dressup.peerQqShow') return null;
  if (path === 'account.listGroupFiles')
    return { targetDirectory: input.folderId, files: [], folders: [] };
  if (path.includes('Permissions') || path.endsWith('.groupPermissions'))
    return { canManage: false };
  if (path.endsWith('.groupJoinSettings'))
    return { groupId: input.groupId, option: 2, categoryId: null };
  if (path.includes('status') || path.includes('Status')) return {};
  return [];
}
function proxy(parts: string[], hooks: boolean): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      const path = parts.join('.');
      if (key === 'query' || key === 'mutate') return (input) => reply(path, input);
      if (key === 'useQuery')
        return (input, options = {}) =>
          useQuery({
            queryKey: ['fixture', path, input],
            queryFn: () => reply(path, input),
            ...options,
          });
      if (key === 'useSubscription') return () => {};
      if (key === 'useMutation')
        return () => ({ mutate: () => {}, mutateAsync: (input) => reply(path, input) });
      if (key === 'useUtils') return () => proxy([], false);
      if (key === 'invalidate' || key === 'refetch') return async () => {};
      return proxy([...parts, String(key)], hooks);
    },
  });
}
export const client = proxy([], false);
export const trpc = proxy([], true);
export const waitForTransport = async () => {};
export const ensureTransport = async () => {};
export const useTrpcReady = () => true;
