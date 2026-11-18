const servers = Array.from({ length: 10 }, (_, index) => ({
  id: `fixture-${index}`,
  name: `合成服务器 ${index + 1}`,
  baseUrl: `https://example.invalid/${index}`,
  pushUrl: `https://example.invalid/push/${index}`,
  accessToken: 'synthetic-token',
  type: index % 2 ? 'http' : 'ws',
  port: 10800 + index,
  requestedPort: 10800 + index,
  token: 'synthetic-token',
  enabled: true,
  running: false,
  clients: 0,
  url: `http://127.0.0.1:${10800 + index}`,
}));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const permissionUsers = Array.from({ length: 80 }, (_, index) => ({
  uin: String(20001 + index),
  name: `合成好友 ${index + 1}`,
}));
const data: Record<string, unknown> = {
  'bootstrap.getSettings': {
    externalRkey: { servers, enabledServerId: null },
    ssePush: { servers, enabledServerId: null, debounceMs: 2000, massThreshold: 50 },
  },
  'bootstrap.getOneBotStatus': {
    uin: '10001',
    accountOpen: true,
    enabled: true,
    config: {
      networks: {
        // 浏览器测试只需要一张能编辑的卡片；其余三类留空，页面照样要渲染出
        // 四个分区（这是「四类网络都在」的回归点）。
        wsServers: Array.from({ length: 10 }, (_, index) => ({
          name: `合成服务器 ${index + 1}`,
          port: 10800 + index,
          enabled: true,
          messageFormat: 'array',
          reportSelfMessage: true,
          accessToken: 'synthetic-token',
        })),
        wsClients: [],
        httpServers: [],
        httpClients: [],
      },
    },
    listeners: [],
    daemonCheck: null,
  },
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
  'account.qqActions.qzoneFriendPermissionList': permissionUsers,
  'account.searchQuick': { friends: [{ uin: '90001', nick: '待添加好友' }] },
};
export const qa = {
  calls: [] as Array<{ path: string; input: unknown }>,
  fail: false,
  delay: 0,
};
const noop = () => {};
const queries = new Map<string, object>();
let preferences: Record<string, unknown> = {};
let preferenceRevision = 0;
function proxy(path = ''): unknown {
  return new Proxy(noop, {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useUtils') return () => proxy();
      if (key === 'useQuery')
        return () => {
          if (!queries.has(path))
            queries.set(path, {
              data: data[path],
              isLoading: false,
              isFetching: false,
              dataUpdatedAt: 1,
              refetch: async () => ({ data: data[path] }),
            });
          return queries.get(path);
        };
      if (key === 'useMutation')
        return () => {
          const [isLoading, setLoading] = useState(false);
          return {
            isLoading,
            mutate: noop,
            mutateAsync: async (input: unknown) => {
              setLoading(true);
              try {
                return await run(path, input);
              } finally {
                setLoading(false);
              }
            },
          };
        };
      if (key === 'mutate') return (input: unknown) => run(path, input);
      if (key === 'query' || key === 'fetch') return async () => data[path] ?? [];
      if (key === 'invalidate') return async () => {};
      if (key === 'then') return undefined;
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
async function run(path: string, input: unknown) {
  if (path === 'clientState.patch') {
    preferences = { ...preferences, ...(input as Record<string, unknown>) };
    return {
      epoch: 'disclosure-editors',
      revision: ++preferenceRevision,
      values: preferences,
      records: {},
    };
  }
  qa.calls.push({ path, input });
  if (qa.delay) await new Promise((resolve) => setTimeout(resolve, qa.delay));
  if (qa.fail) throw new Error('合成操作失败');
  if (path === 'account.qqActions.qzoneFriendPermission') {
    const target = input as { targetUin: string };
    permissionUsers.push({ uin: target.targetUin, name: '待添加好友' });
    return { state: 'confirmed' };
  }
  return path === 'account.qqActions.signatureComment' ? { commentId: 'new-comment' } : {};
}
export const trpc = proxy();
export const client = proxy();
import { useState } from 'react';
