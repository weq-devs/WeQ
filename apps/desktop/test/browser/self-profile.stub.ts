import { useCallback, useEffect, useSyncExternalStore } from 'react';

let revision = 0;
let pageCount = 0;
let failed = false;
let online = true;
let fetching = false;
let requests = 0;
let writes = 0;
let failSave = false;
let account = '10001';
const listeners = new Set<() => void>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const useData = () => useSyncExternalStore(subscribe, () => revision);
const profile = {
  uid: 'u_self',
  uin: '10001',
  qid: 'synthetic-qid',
  nick: '合成名片昵称',
  signature: '一段用于验证换行的合成个性签名。',
  gender: 2,
  birthYear: 2005,
  birthMonth: 2,
  birthDay: 3,
  age: 21,
  extInfo: { interests: ['摄影', '音乐'], degree: '本科', privileges: [], album: [] },
};
const extra = {
  birthday: '2005-02-03',
  region: ['1', '2', '3'],
  email: 'synthetic@example.test',
  profession: 1,
  hometown: ['1', '2', '3', '0'],
  school: '合成学校',
  company: '合成公司',
  personalDescription: '第一行个人说明\n第二行个人说明',
  errors: {},
};
export function withFallback<T extends object>(target: T): T {
  const fallback = (): unknown =>
    new Proxy(() => fallback(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: undefined,
              isLoading: false,
              isFetching: false,
              refetch: async () => ({ data: undefined }),
            })
          : key === 'useMutation'
            ? () => ({ mutateAsync: async () => undefined })
            : key === 'query' || key === 'fetch' || key === 'invalidate'
              ? async () => null
              : key === 'useSubscription'
                ? () => undefined
                : fallback(),
    });
  for (const value of Object.values(target))
    if (value && typeof value === 'object') withFallback(value);
  Object.setPrototypeOf(target, fallback());
  return target;
}
const options = {
  regions: [
    {
      code: '1',
      name: '中国',
      children: [
        {
          code: '2',
          name: '福建',
          children: [
            { code: '3', name: '厦门', children: [{ code: '0', name: '未指定', children: [] }] },
          ],
        },
      ],
    },
  ],
  professions: [
    { value: 1, label: '学生' },
    { value: 2, label: '工程师' },
  ],
};
const avatar = (id: string, first: number | null, last: number | null) => ({
  id,
  firstUsedAt: first,
  lastUsedAt: last,
  thumbnailUrl: `https://q1.qlogo.cn/synthetic/${id}/100`,
  url: `https://q1.qlogo.cn/synthetic/${id}/0`,
  fileSize: 12345,
  faceFlag: 63,
});
const avatars = [
  avatar('a', 1000000000, 1700000000),
  avatar('b', 1600000000, 1600000000),
  avatar('c', 900000000, 1500000000),
  avatar('unknown', null, null),
];
const page = (items: typeof avatars, next: number | null) => ({
  targetUin: account,
  items,
  nextCursor: next,
  hasMore: next !== null,
  paginationError: null,
});
const pages = () =>
  pageCount === 0
    ? []
    : [
        page(avatars.slice(0, 2), 1600000000),
        ...(pageCount > 1 ? [page([avatars[1]!, ...avatars.slice(2)], null)] : []),
      ];
const state = () => ({
  profile: { ...profile, uin: account },
  status: { type: 10, subType: 0 },
  statusError: null,
  statusOptions: [
    { value: 10, label: '在线' },
    { value: 30, label: '离开' },
  ],
});
function useFixtureQuery<T>(get: () => T) {
  useData();
  return {
    data: get(),
    isFetching: false,
    error: null,
    dataUpdatedAt: revision,
    refetch: async () => ({ data: get(), error: null }),
  };
}
function useHistory(_input: unknown, opts: { enabled: boolean }) {
  useData();
  const fetchNextPage = useCallback(async () => {
    if (fetching || !online) return;
    requests++;
    fetching = true;
    failed = false;
    changed();
    await new Promise((resolve) => setTimeout(resolve, 120));
    fetching = false;
    pageCount++;
    changed();
  }, []);
  useEffect(() => {
    if (opts.enabled && !pageCount && !fetching && !failed) void fetchNextPage();
  }, [opts.enabled, fetchNextPage]);
  return {
    data: pageCount ? { pages: pages() } : undefined,
    isFetching: fetching,
    error: failed ? new Error('合成错误') : null,
    hasNextPage: pageCount === 1,
    dataUpdatedAt: revision,
    fetchNextPage,
    refetch: async () => {
      failed = false;
      await fetchNextPage();
    },
  };
}
const mutate = async (input: { patch?: Record<string, unknown> }) => {
  writes++;
  if (input.patch) {
    Object.assign(profile, input.patch.nickname ? { nick: input.patch.nickname } : input.patch);
    Object.assign(extra, input.patch);
  }
  changed();
  return { state: 'accepted' };
};
const mutation = { useMutation: () => ({ mutateAsync: mutate }) };
const invalidation = { invalidate: async () => {} };
export const trpc = withFallback({
  bootstrap: {
    getSettings: { useQuery: () => useFixtureQuery(() => ({ exportSaveMode: 'before' })) },
  },
  useUtils: () => ({
    account: {
      getSelfProfile: invalidation,
      getOnlineStatus: invalidation,
      profileExtras: { signatureHistory: invalidation },
    },
  }),
  account: {
    getSelfProfile: { useQuery: () => useFixtureQuery(() => ({ ...profile, uin: account })) },
    getAccountConfig: {
      useQuery: () => useFixtureQuery(() => ({ uin: account, configId: 'fixture' })),
    },
    getSelfVip: { useQuery: () => useFixtureQuery(() => null) },
    onVipChanged: { useSubscription: () => {} },
    dressup: { peerStats: { useQuery: () => useFixtureQuery(() => ({ level: 32 })) } },
    getSystemFaces: {
      useQuery: () =>
        useFixtureQuery(() => [{ id: 0, desc: '[微笑]', emojiType: 1, unicodeId: 0 }]),
    },
    qqActions: {
      extendedStatuses: {
        useQuery: () => useFixtureQuery(() => [{ value: 1018, label: '学习中' }]),
      },
    },
    qqWrite: {
      selfState: { useQuery: () => useFixtureQuery(state) },
      editableSelfProfile: { useQuery: () => useFixtureQuery(() => extra) },
      profileRegions: { useQuery: () => useFixtureQuery(() => options) },
      selfProfile: mutation,
      selfAvatar: mutation,
      onlineStatus: mutation,
      editSelfProfile: mutation,
    },
    profileExtras: {
      signatureHistory: { useInfiniteQuery: () => useFixtureQuery(() => ({ pages: [] })) },
      energy: {
        useQuery: () => useFixtureQuery(() => ({ targetUin: account, score: 831, level: 1 })),
      },
      avatarHistory: { useInfiniteQuery: useHistory },
    },
  },
});
export const client = withFallback({ account: { qqWrite: { onlineStatus: { mutate } } } });
export function useQQWriteSession() {
  useData();
  return {
    binding: { expectedAccountUin: account, expectedAccountConfigId: 'fixture' },
    available: online,
    busy: false,
    run: async (
      action: (binding: unknown) => Promise<unknown>,
      _refresh?: unknown,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      if (failSave) return false;
      await action({ expectedAccountUin: account, expectedAccountConfigId: 'fixture' });
      return options?.readback ? options.readback() : true;
    },
  };
}
export const qa = {
  requests: () => requests,
  writes: () => writes,
  failSave: (value: boolean) => {
    failSave = value;
  },
  failHistory: () => {
    pageCount = 1;
    failed = true;
    changed();
  },
  online: (value: boolean) => {
    online = value;
    changed();
  },
  account: (value: string) => {
    account = value;
    pageCount = 0;
    changed();
  },
};
