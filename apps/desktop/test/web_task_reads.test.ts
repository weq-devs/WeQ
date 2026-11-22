import { createTRPCUntypedClient } from '@trpc/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@trpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@trpc/client')>();
  return {
    ...actual,
    createWSClient: vi.fn(() => ({})),
    wsLink: vi.fn(() => () => () => {
      throw new Error('此用例不应使用订阅');
    }),
  };
});

afterEach(() => vi.unstubAllGlobals());

it('慢空间读取不阻塞同刻发出的空间详情、普通设置读取和业务写入', async () => {
  const slowPath = 'account.qzone.people';
  const requests: string[][] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    const paths = url.pathname.slice('/trpc/'.length).split(',');
    requests.push(paths);
    if (paths.includes(slowPath)) await held;
    const results = paths.map((path) => ({ result: { data: path } }));
    return new Response(JSON.stringify(url.searchParams.has('batch') ? results : results[0]));
  });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const slow = client.query(slowPath);
  const fast = [
    client.query('account.qzone.detail'),
    client.query('account.qzonePublic.feeds'),
    client.query('bootstrap.getSettings'),
    client.mutation('account.qzone.cancel'),
  ];
  try {
    await vi.waitFor(() =>
      expect(requests.flat()).toEqual(
        expect.arrayContaining([slowPath, 'account.qzone.detail', 'bootstrap.getSettings']),
      ),
    );
    expect(requests).toContainEqual([slowPath]);
    await expect(Promise.all(fast)).resolves.toEqual([
      'account.qzone.detail',
      'account.qzonePublic.feeds',
      'bootstrap.getSettings',
      'account.qzone.cancel',
    ]);
  } finally {
    release();
    await Promise.allSettled([slow, ...fast]);
  }
});

it('真实 HTTP link 在慢目录未结束时仍返回任务和常规会话列表所需的读取', async () => {
  const requests: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slowFinished = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), location.origin);
      requests.push(url.pathname);
      const batched = url.searchParams.has('batch');
      if (/account\.(list(Buddies|AllGroups)|emojiPanel\.favorites)/.test(url.pathname))
        await blocked;
      const results = url.pathname
        .slice('/trpc/'.length)
        .split(',')
        .map((path) => ({ result: { data: `/trpc/${path}` } }));
      return new Response(JSON.stringify(batched ? results : results[0]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const slow = client.query('account.listBuddies').then(() => {
    slowFinished = true;
  });
  const slowGroups = client.query('account.listAllGroups');
  const slowFavorites = client.query('account.emojiPanel.favorites');
  const emojiCatalog = client.query('account.emojiPanel.catalog');
  const config = client.query('account.getAccountConfig');
  try {
    await vi.waitFor(() => {
      expect(requests.find((path) => path.includes('account.getAccountConfig'))).toBeDefined();
      expect(requests).toContain('/trpc/account.emojiPanel.catalog');
      expect(requests).toContain('/trpc/account.emojiPanel.favorites');
    });
    expect(requests).toContain('/trpc/account.getAccountConfig');
    expect(await config).toBe('/trpc/account.getAccountConfig');
    expect(await emojiCatalog).toBe('/trpc/account.emojiPanel.catalog');
    const values = await Promise.all([
      client.query('backgroundTasks.list'),
      client.query('backgroundTasks.logs'),
      client.query('account.listExportTasks'),
      client.query('account.flashDownloadTaskLogs'),
    ]);
    expect(values).toEqual([
      '/trpc/backgroundTasks.list',
      '/trpc/backgroundTasks.logs',
      '/trpc/account.listExportTasks',
      '/trpc/account.flashDownloadTaskLogs',
    ]);
    const firstPage = [
      'account.getUnreadInfos',
      'account.listRecentContactTargets',
      'account.listTopContacts',
      'account.listConversationDraftTimes',
      'clientState.snapshot',
      'clientState.accountSnapshot',
    ];
    const directory = [
      'account.listHiddenSessions',
      'account.listDeletedSessions',
      'account.listOfficialAccounts',
      'account.listServiceAccounts',
      'account.guildDirectListSessions',
      'account.listAgentLabPersonas',
      'account.listAgentLabGroups',
    ];
    const visibleReads = [
      ...firstPage,
      ...directory,
      'account.listRecentContacts',
      'account.listAssistantSessions',
    ];
    const before = requests.length;
    expect(await Promise.all(visibleReads.map((path) => client.query(path)))).toEqual(
      visibleReads.map((path) => `/trpc/${path}`),
    );
    const startupRequests = requests.slice(before);
    expect(startupRequests).toHaveLength(4);
    expect(startupRequests).toContain(`/trpc/${firstPage.join(',')}`);
    expect(startupRequests).toContain(`/trpc/${directory.join(',')}`);
    expect(slowFinished).toBe(false);
  } finally {
    release();
    await Promise.all([slow, slowGroups, slowFavorites, emojiCatalog, config]);
  }
});
