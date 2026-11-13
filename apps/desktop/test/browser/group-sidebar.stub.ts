import { useQuery } from '@tanstack/react-query';

/** 群聊天侧栏渲染用桩：与 group-audit 同源，默认返回可用数据。 */
const calls: string[] = [];
const preferences = { epoch: 'fixture', revision: 0, values: {}, records: {} };
const todos = [
  {
    sequence: '816',
    sourceId: '816_1',
    text: '周五交作业，记得填写课题与组员信息。'.repeat(10),
    completed: false,
    updatedAt: 1794528000,
  },
  { sequence: '812', sourceId: '812_1', text: '确认周六活动人数', completed: true },
];
Object.assign(window, { groupAuditCalls: calls });
const mode = () => (window as unknown as { __groupAuditMode?: string }).__groupAuditMode ?? 'ok';
const row = (n: number) => ({
  uid: `u_member${n}`,
  uin: String(10000 + n),
  card: `成员 ${n}`,
  nick: `昵称 ${n}`,
  joinTime: 1700000000,
  lastSpeakTime: 0,
  muteUntil: 0,
  adminFlag: n === 2 ? 1 : 0,
  memberFlag: 0,
  customTitle: n === 2 ? '活跃分子' : '',
  memberLevel: 3,
});
async function reply(path: string, input: Record<string, unknown>) {
  calls.push(path);
  if (path === 'clientState.patch') {
    preferences.revision++;
    Object.assign(preferences.values, input);
    return structuredClone(preferences);
  }
  if (path === 'account.getAccountConfig') return { uin: '99999', configId: 'fixture' };
  if (path === 'account.qqActions.groupPermissions')
    return { canManage: true, isOwner: false, isMember: true, selfUin: '99999' };
  if (path === 'account.qqActions.todoList' || path === 'account.qqActions.todoLocalList') {
    if (mode() === 'error') throw new Error('暂时无法读取待办，请稍后重试');
    if (mode() === 'empty') return [];
    return todos;
  }
  if (path === 'account.qqActions.todo') {
    const todo = todos.find((item) => item.sequence === input.sequence);
    if (todo) todo.completed = input.action === 'complete';
    return { state: 'confirmed' };
  }
  if (path === 'account.qqActions.notices')
    return [
      {
        noticeId: 'notice-1',
        senderId: 10001,
        text: '这周的签到改到周六晚上八点，别忘记打卡。'.repeat(12),
        publishTime: 1794528000,
        images: [],
      },
    ];
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
  if (path === 'account.getGroupDetail') {
    if (mode() === 'error') throw new Error('群资料读取失败');
    return mode() === 'empty'
      ? {
          groupCode: 12345,
          groupName: '空资料群',
          remark: null,
          description: null,
          memberCount: 0,
          maxMemberCount: 0,
          createTime: 0,
          labels: '',
          customLabels: [],
          entranceQ: null,
          pinnedAnnounce: null,
          ownerUid: 'u_member1',
        }
      : {
          groupCode: 12345,
          groupName: mode() === 'long' ? '原来的群名称'.repeat(8) : '原来的群名称',
          remark: mode() === 'long' ? '我的群备注'.repeat(10) : '我的群备注',
          description:
            '这是一段很长的群简介，用来观察三行截断是否自然、展开后是否会把下方内容挤走，以及文字能否被选中复制。\n'.repeat(
              6,
            ),
          memberCount: 255,
          maxMemberCount: 1000,
          createTime: 1609459200,
          labels: '同学',
          customLabels: [{ content: '音乐' }, { content: '拼车' }],
          entranceQ: '入群请说明来意',
          pinnedAnnounce: '只在完整资料显示的公告',
          ownerUid: 'u_member1',
        };
  }
  if (path === 'account.groupMemberPreview') {
    if (mode() === 'error') throw new Error('读取成员预览失败');
    if (mode() === 'slow') await new Promise((resolve) => setTimeout(resolve, 2500));
    else await new Promise((resolve) => setTimeout(resolve, 350));
    if (mode() === 'empty') return { members: [], source: 'local', partial: true, error: null };
    return {
      members: Array.from({ length: 8 }, (_, i) => row(i + 1)),
      source: 'local',
      partial: true,
      error: null,
    };
  }
  if (path === 'account.contactMetrics.snapshot') {
    if (mode() === 'nometric') return { rows: {} };
    if (mode() === 'empty') return { rows: {} };
    return {
      rows: {
        'group:12345': {
          friendCount: {
            value: 3,
            updatedAt: 1794380000000,
            attemptedAt: 1794380000000,
            state: 'ready',
          },
          activityScore: {
            value: 720,
            updatedAt: 1794380000000,
            attemptedAt: 1794380000000,
            state: 'ready',
          },
        },
      },
    };
  }
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
  if (path === 'account.listGroupMembers') {
    if (mode() === 'error') throw new Error('读取群成员失败');
    return input.offset ? [] : Array.from({ length: 10 }, (_, i) => row(i + 1));
  }
  if (path === 'account.searchGroupMembers') return { members: [row(3)], total: 1 };
  if (path === 'account.getGroupEssencePageWithContent') return { complete: true, messages: [] };
  if (path === 'account.qqActions.groupReadTools')
    return {
      signed: Array.from(
        { length: Math.min(100, Math.max(0, 120 - Number(input.offset ?? 0))) },
        (_, index) => ({
          userId: 10001 + Number(input.offset ?? 0) + index,
          nick: `成员 ${Number(input.offset ?? 0) + index + 1}`,
          rank: Number(input.offset ?? 0) + index + 1,
          time: 1794528000 + (Number(input.offset ?? 0) + index) * 60,
        }),
      ),
      atAll: { canAtAll: false, remainCountForUin: 0, remainCountForGroup: 0 },
    };
  if (path === 'account.contactMetrics.history.status')
    return { migrating: false, migrationErrors: [], lastError: null };
  if (path === 'account.contactMetrics.history.list') return { rows: [], hasMore: false };
  if (path === 'account.getProfile' || path === 'account.getProfileByUin') return null;
  if (path === 'account.qqWrite.commonRelationships') return { friendCount: 0, groups: [] };
  if (path === 'account.dressup.peerStats') return { level: 10, likeCount: 0 };
  if (path === 'account.dressup.peerHome' || path === 'account.dressup.peerQqShow') return null;
  if (path === 'account.getCardDisplayNames') return { name: '云端群名称', remark: null };
  if (path === 'account.listGroupFiles')
    return {
      targetDirectory: input.folderId,
      files: [
        {
          fileId: 'fixture-file-1',
          fileName: '周末活动安排.pdf',
          fileSize: 524288,
          busId: 102,
          uploadedTime: 1794528000,
          expireTime: 0,
          modifiedTime: 1794528000,
          downloadedTimes: 12,
          uploaderUin: 10001,
          uploaderName: '成员 1',
          parentDirectory: input.folderId ?? '/',
        },
        {
          fileId: 'fixture-file-2',
          fileName: '很长的文件名称用于检查文件列表不会出现横向溢出或遮挡.docx',
          fileSize: 1048576,
          busId: 102,
          uploadedTime: 1794528060,
          expireTime: 0,
          modifiedTime: 1794528060,
          downloadedTimes: 3,
          uploaderUin: 10002,
          uploaderName: '成员 2',
          parentDirectory: input.folderId ?? '/',
        },
      ],
      folders: [],
    };
  if (path === 'account.listGroupAlbums')
    return ['周末活动', '资料图片'].map((title, index) => ({
      id: `fixture-album-${index + 1}`,
      title,
      photoCount: 0,
      coverUrl: '',
      desc: '',
      createUin: 10001,
      createNickname: '成员 1',
      createTime: '2026-11-13T08:00:00+08:00',
      updateTime: '2026-11-13T08:00:00+08:00',
    }));
  if (path === 'account.listGroupAlbumMedia') return [];
  if (path === 'account.qqActions.fileSummary')
    return { fileCount: 2, maxCount: 1000, usedSpace: 1572864, totalSpace: 10737418240 };
  if (path === 'account.qqActions.folders')
    return { targetDirectory: input.directory ?? '/', files: [], folders: [] };
  if (path.includes('Permissions')) return { canManage: false };
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
      if (key === 'query' || key === 'mutate')
        return (input: Record<string, unknown>) => reply(path, input ?? {});
      if (key === 'useQuery')
        return (input: unknown, options: Record<string, unknown> = {}) =>
          useQuery({
            queryKey: ['fixture', path, input, mode()],
            queryFn: () => reply(path, (input ?? {}) as Record<string, unknown>),
            ...options,
          });
      if (key === 'useSubscription') return () => {};
      if (key === 'useMutation') return () => ({ mutate: () => {}, mutateAsync: async () => ({}) });
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
