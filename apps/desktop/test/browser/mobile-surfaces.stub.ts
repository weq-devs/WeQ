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
