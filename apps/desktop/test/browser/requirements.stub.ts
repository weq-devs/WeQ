import { useState } from 'react';
let preferences = {
  revision: 0,
  values: { messageNotifications: false, applicationBadge: true },
  records: {},
};
export const accountBinding = () => ({
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'fixture',
});
export const qa = { exports: [] as unknown[], remote: false };
export const savedReport = {
  request: {
    id: 'report-a',
    kind: 'buddy' as const,
    peerUid: 'peer',
    name: '合成联系人',
    period: '全部消息',
    scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  },
  status: 'completed',
  results: {},
  pending: {},
  completed: ['report'],
  logs: [],
  revision: 2,
  resultRevision: 2,
  position: 0,
  updatedAt: 1794441600000,
};
Object.assign(window, { requirementsQa: qa });
export function useExportSavePolicy() {
  const [serverLocation, setServerLocation] = useState<{ name: string } | null>(null);
  const [resolve, setResolve] = useState<{ done(value: string | null): void } | null>(null);
  return {
    binding: accountBinding(),
    settings: { isLoading: false },
    isCurrent: () => true,
    serverLocation,
    chooseServerLocation: (directory: string | null) => {
      resolve?.done(directory);
      setServerLocation(null);
    },
    prepareSave: async () => {
      const directory = qa.remote
        ? '.'
        : await new Promise<string | null>((done) => {
            setResolve({ done });
            setServerLocation({ name: '选中的相册内容' });
          });
      return directory === null ? null : { mode: 'before' as const, directory };
    },
  };
}
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const next = `${path}.${String(key)}`;
      if (key === 'useQuery')
        return () => ({
          data: path.endsWith('.getAccountConfig')
            ? { uin: '10001', configId: 'fixture' }
            : path.endsWith('.analysisReports.get')
              ? savedReport
              : path.endsWith('.analysisReports.list')
                ? [
                    savedReport,
                    {
                      ...savedReport,
                      request: {
                        ...savedReport.request,
                        id: 'report-b',
                        name: '合成群聊',
                        kind: 'group',
                        groupCode: '10003',
                      },
                      status: 'paused',
                      completed: ['report'],
                    },
                  ]
                : path.endsWith('.analysisReports.versions')
                  ? [savedReport, { ...savedReport, resultRevision: 1 }]
                  : path.endsWith('.analysisReports.version')
                    ? { ...savedReport, resultRevision: 1 }
                    : undefined,
          isLoading: false,
          refetch: async () => ({ data: undefined }),
        });
      if (key === 'mutate')
        return async (input: Record<string, unknown>) => {
          if (path.endsWith('.clientState.patch')) {
            preferences = {
              ...preferences,
              revision: preferences.revision + 1,
              values: { ...preferences.values, ...input },
            };
            return preferences;
          }
          if (path.endsWith('.startAlbumReferenceExport')) qa.exports.push(input);
          return 'task-fixture';
        };
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'useSubscription') return () => undefined;
      if (key === 'query') return async () => null;
      return proxy(next);
    },
  });
export const client = proxy();
export const trpc = proxy();
