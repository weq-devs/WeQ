const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const region = [{ code: '1', name: '合成地区名称', children: [] }];
const data: Record<string, unknown> = {
  'account.getAccountConfig': { uin: '10001', configId: 'fixture' },
  'account.getGroupAlbumAccessState': {
    qqOnline: true,
    attachEnabled: true,
    hasA2: true,
    hasD2: true,
    hasD2Key: true,
    hasGuid: true,
    ssoReady: true,
    source: binding,
  },
  'account.qqWrite.selfState': {
    profile: {
      uid: 'u_fixture',
      uin: '10001',
      nick: '合成昵称'.repeat(12),
      gender: 1,
      signature: '合成签名'.repeat(40),
    },
    status: {
      type: 10,
      subType: 2000,
      customStatus: { faceId: 14, faceType: 1, text: '合成自定义状态' },
    },
    statusOptions: [
      { value: 10, label: '在线' },
      { value: 40, label: '隐身' },
    ],
  },
  'account.qqWrite.editableSelfProfile': {
    birthday: '2000-01-01',
    email: 'fixture@example.invalid',
    profession: 1,
    school: '合成学校'.repeat(15),
    region: ['1', '1', '1'],
    hometown: ['1', '1', '1', '1'],
    errors: {},
  },
  'account.qqWrite.profileRegions': {
    regions: region,
    professions: [{ value: 1, label: '合成职业' }],
  },
  'account.qqActions.extendedStatuses': [{ value: 1018, label: '学习中' }],
  'account.qqWrite.exactProfile': {
    kind: 'user',
    name: '合成搜索结果'.repeat(36),
    id: '10001',
    level: 100,
  },
  'account.getSystemFaces': [{ id: 14, desc: '[合成表情]', emojiType: 1, unicodeId: 0 }],
  'account.listCollections': {
    items: [
      {
        cid: 'fixture',
        kind: 'text',
        type: 1,
        createTime: 1700000000,
        collectTime: 1700000000,
        authorName: '合成来源'.repeat(12),
        authorUin: '10001',
        groupName: '',
        text: '合成收藏内容'.repeat(30),
        fullContent: '',
        fullContentFormat: 'text',
        link: null,
        gallery: null,
        audio: null,
        video: null,
        file: null,
        location: null,
        richMedia: null,
      },
    ],
    hasMore: false,
  },
  'account.qzone.feeds': { feeds: [], hasMore: false },
  'clientState.draftCopies': [
    {
      key: 'copy:0f6a1d2c-1111-4aaa-8bbb-000000000001',
      version: 'v1',
      value: {
        source: 'chat:c2c:10001:20002',
        content: { text: '这是被自动保留的聊天草稿副本内容，用来覆盖别人同时保存造成的版本差异。' },
        createdAt: 1762984800000,
      },
    },
    {
      key: 'copy:0f6a1d2c-2222-4aaa-8bbb-000000000002',
      version: 'v1',
      value: {
        source: 'assistant:draft:研讨会议纪要',
        content: { text: '助手草稿副本：今天讨论的结论汇总。' },
        createdAt: 1762981200000,
      },
    },
  ],
  'clientState.draft': {
    value: '这是完整草稿内容，用于查看全文时替换预览。',
  },
  'bootstrap.backupInventory': {
    canPickFile: false,
    canRestart: false,
    maxArchiveBytes: 268435456,
    chunkBytes: 65536,
    accounts: [{ configId: 'fixture', uin: '10001', displayName: '合成账号' }],
    cloneScopes: ['fixture-clone'],
    restore: { pending: null, result: null },
  },
  'bootstrap.backupDefaultsInfo': { clientId: null, pending: null, canClaim: false },
  'bootstrap.restoreStatus': {
    ok: true,
    error: null,
    result: null,
    appliedThisStartup: false,
    client: null,
    canReveal: false,
    canRestart: false,
  },
  'mail.preferences': {
    pollIntervalMinutes: 1,
    showUnread: true,
    notifications: false,
    lastSync: null,
  },
  'mail.status': { state: 'ready', unread: 0, notifications: false, lastSync: null, error: null },
  'mail.folders': [{ id: 1, name: '收件箱', unread: 0, total: 0, locked: false }],
  'mail.list': { items: [], page: 0, total: 0, unread: 0, hasMore: false },
};
const results = new Map<string, object>();
const noop = () => {};
function proxy(path = ''): unknown {
  return new Proxy(noop, {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => {
          if (!results.has(path))
            results.set(path, {
              data: data[path],
              isLoading: false,
              isFetching: false,
              isError: false,
              dataUpdatedAt: 1,
              refetch: async () => ({ data: data[path] }),
            });
          return results.get(path);
        };
      if (key === 'useMutation')
        return () => ({ mutate: noop, mutateAsync: async () => undefined, isLoading: false });
      if (key === 'useSubscription') return noop;
      if (key === 'subscribe') return () => ({ unsubscribe: noop });
      if (key === 'then') return undefined;
      if (key === 'query' || key === 'fetch' || key === 'mutate')
        return async () => data[path] ?? [];
      if (key === 'invalidate') return async () => undefined;
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
