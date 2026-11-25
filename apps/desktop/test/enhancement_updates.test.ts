// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Platform } from '@weq/platform';
import { getOcrModel, OCR_MODELS, UserConfigService, VOICE_MODELS } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';
import { EnhancementUpdateController, resourceCatalogFor } from '../src/main/enhancements/updates';
import type { ReleaseDescriptor, ReleaseIndex } from '@weq/network/release-metadata';
import { gzipSync } from 'node:zlib';
import { createMarketEmojiComponent } from '../src/main/enhancements/market_emoji_component';
import { searchCatalog, setMarketCatalogReader } from '../src/main/market_catalog';
import { EnhancementPacks, type EnhancementComponentState } from '../src/main/enhancements/packs';
import {
  createRelease,
  releaseContentVersion,
  modelReleaseComponent,
} from '../src/main/enhancements/release_catalog';
import {
  enhancementReleaseBlocker,
  parseEnhancementCatalog,
  parseEnhancementCatalogForHost,
} from '../src/shared/enhancement_release';
import { backgroundTasks } from '../src/main/background_tasks';
import {
  enhancementDownloadTask,
  forgetEnhancementTask,
  forgetRemovedPackTask,
  restoreEnhancementTasks,
  startEnhancementDownloads,
  trackEnhancementPreparation,
} from '../src/main/enhancements/tasks';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { networkCost } from '@weq/service/data-saver';
import { enhancementEngineCompatibility } from '../src/shared/enhancement_manifest';
import { enhancementProcedures } from '../src/main/ipc/routers/enhancements';
import { router } from '../src/main/ipc/trpc';
import { summarizeWorkspaceTasks } from '../src/renderer/src/lib/workspaceIndicators';
import { TaskNotificationTracker } from '../src/renderer/src/lib/taskNotificationState';

const host = vi.hoisted(() => ({ bootstrap: {} as unknown }));
vi.mock('../src/main/context/app_context', () => ({ requireBootstrap: () => host.bootstrap }));

const roots: string[] = [];
const controllers: EnhancementUpdateController[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
it('统一索引的两包分别校验资产和兼容身份', () => {
  const keyId = 'c'.repeat(32);
  const dressTag = 'dress-index-0123456789ab';
  const marketTag = 'market-emoji-0123456789ab';
  const url = (tag: string) =>
    `https://github.com/weq-devs/dress-resources/releases/download/${tag}`;
  const parts = Object.fromEntries(
    ['bubble', 'font', 'widget'].map((kind) => [
      kind,
      { asset: `dress-${kind}.dat`, size: 64, sha256: sha(kind) },
    ]),
  );
  const dress = createRelease(
    'dress',
    [
      {
        type: 'dress',
        manifest: {
          schemaVersion: 1,
          baseUrl: url(dressTag),
          tag: dressTag,
          format: 'ntdr-v2',
          keyId,
          parts,
        },
      },
    ],
    '2.8.0',
  );
  const market = createRelease(
    'market-emoji',
    [
      {
        type: 'market-emoji',
        asset: {
          name: 'market.csv.gz',
          url: url(marketTag) + '/market.csv.gz',
          sizeBytes: 32,
          sha256: sha('market'),
        },
      },
    ],
    '2.8.0',
  );
  const descriptor = (
    track: 'dress' | 'market-emoji',
    tag: string,
    name: string,
    pack: typeof dress,
    assets: ReleaseDescriptor['assets'],
  ): ReleaseDescriptor => ({
    track,
    tag,
    version: null,
    prerelease: false,
    publishedAt: '2026-11-23T00:00:00Z',
    catalogs: { [name]: JSON.stringify({ schemaVersion: 1, packs: [pack] }) },
    assets,
  });
  const index: ReleaseIndex = {
    schemaVersion: 1,
    kind: 'resource-release-index',
    repository: 'weq-devs/dress-resources',
    generatedAt: '2026-11-23T00:00:00Z',
    releases: [
      descriptor(
        'dress',
        dressTag,
        'enhancement-dress-v2.json',
        dress,
        Object.values(parts).map((part) => ({
          name: part.asset,
          size: part.size,
          sha256: part.sha256,
        })),
      ),
      descriptor('market-emoji', marketTag, 'enhancement-market-emoji.json', market, [
        { name: 'market.csv.gz', size: 32, sha256: sha('market') },
      ]),
    ],
  };
  const read = (track: 'dress' | 'market-emoji', version = '2.8.0') =>
    resourceCatalogFor(index, track, version, 'darwin-arm64', false)?.packs[0];
  expect(read('dress')).toEqual(dress);
  expect(read('market-emoji')).toEqual(market);
  expect(read('dress', '2.7.5')?.unavailable).toContain('2.8.0');
  expect(enhancementReleaseBlocker(dress, '2.8.0', 'b'.repeat(40), [keyId])).toBeNull();
  expect(enhancementReleaseBlocker(dress, '2.8.0', undefined, [])).toContain('原生模块');
  index.releases[0]!.assets[0]!.sha256 = sha('wrong');
  expect(() => read('dress')).toThrow('签名资产身份');
  expect(read('market-emoji')).toEqual(market);
});

it('商城目录更新失败保留旧版，删除会取消暂停的更新并清理任务和文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-market-emoji-'));
  roots.push(root);
  const installedPath = join(root, 'market-emoji');
  const receiptPath = join(root, 'ready.json');
  const csv = (name: string) => `id,name,mark,feetype\n248001,${name},"包含,逗号",1\n`;
  let response: string | Buffer = csv('第一版');
  let streaming: PromiseWithResolvers<AbortSignal> | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    if (streaming) {
      streaming.resolve(init!.signal!);
      return new Response(new ReadableStream());
    }
    return new Response(typeof response === 'string' ? response : new Uint8Array(response));
  };
  const create = () => {
    const catalog = createMarketEmojiComponent(installedPath, fetcher);
    const packs = new EnhancementPacks(
      [
        {
          id: 'market-emoji',
          name: '商城表情目录',
          description: '',
          enabled: true,
          components: [catalog.component.id],
          validate: catalog.validate,
        },
      ],
      new Map([[catalog.component.id, catalog.component]]),
      root,
    );
    return { catalog, packs };
  };
  const select = (packs: EnhancementPacks, content: string | Buffer) => {
    const name = typeof content === 'string' ? 'market.csv' : 'market.csv.gz';
    packs.selectRelease(
      createRelease('market-emoji', [
        {
          type: 'market-emoji',
          asset: {
            name,
            url: `https://example.invalid/${name}`,
            sizeBytes: Buffer.byteLength(content),
            sha256: createHash('sha256').update(content).digest('hex'),
          },
        },
      ]),
      null,
    );
  };
  const install = async (packs: EnhancementPacks, content: string | Buffer) => {
    select(packs, content);
    packs.start(['market-emoji']);
    await packs.wait();
  };
  try {
    const { packs } = create();
    expect(searchCatalog({}).catalogVersion).toBeNull();
    await install(packs, response);
    expect(searchCatalog({ keyword: '包含,逗号' }).entries[0]?.name).toBe('第一版');

    response = '有相符的哈希，但不是目录';
    await install(packs, response);
    expect((await packs.list())[0]?.operation?.phase).toBe('failed');
    expect(searchCatalog({}).entries[0]?.name).toBe('第一版');

    response = gzipSync(csv('第二版'));
    await install(packs, response);
    expect(searchCatalog({}).entries[0]?.name).toBe('第二版');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))['market-emoji'];
    const reopened = create();
    reopened.catalog.restore(receipt.components[0].version);
    expect(searchCatalog({}).entries[0]?.name).toBe('第二版');
    restoreEnhancementTasks(reopened.packs, root);
    streaming = Promise.withResolvers<AbortSignal>();
    select(reopened.packs, gzipSync(csv('第三版')));
    await startEnhancementDownloads(reopened.packs, ['market-emoji']);
    const requestSignal = await streaming.promise;
    reopened.packs.pause('market-emoji');
    expect(requestSignal.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(enhancementDownloadTask(reopened.packs, 'market-emoji')?.status).toBe('paused'),
    );
    await reopened.packs.remove('market-emoji');
    await forgetRemovedPackTask(reopened.packs, 'market-emoji');
    expect(backgroundTasks.snapshot()).toEqual([]);
    expect(JSON.parse(await readFile(join(root, 'download-tasks.json'), 'utf8'))).toEqual({});
    expect((await reopened.packs.list())[0]).toMatchObject({
      installed: false,
      busy: false,
      sizeOnDisk: 0,
    });
    expect(searchCatalog({}).catalogVersion).toBeNull();
  } finally {
    setMarketCatalogReader(() => null);
  }
});
const nativeCommit = 'a'.repeat(40);
// 本文件覆盖旧发布契约；新签名索引端点明确不存在，不消耗旧接口的失败注入。
const legacyFetch =
  (fetcher: typeof fetch): typeof fetch =>
  (url, init) =>
    /\/weq-(?:resource|update)-feed\/update-index\.json/.test(String(url))
      ? Promise.resolve(new Response('', { status: 404 }))
      : fetcher(url, init);
function release(revision: string, minWeqVersion = '2.6.1') {
  return createRelease(
    'dress',
    [
      {
        type: 'dress',
        manifest: {
          schemaVersion: 1,
          format: 'ntdr-v1',
          tag: `dress-${revision}`,
          nativeCommit,
          baseUrl: `https://example.invalid/${revision}`,
          parts: Object.fromEntries(
            ['bubble', 'font', 'widget'].map((kind) => [
              kind,
              { asset: `dress-${kind}.dat`, size: 32, sha256: sha(revision) },
            ]),
          ),
        },
      },
    ],
    minWeqVersion,
  );
}
async function fixture(installed = true, existingRoot?: string, currentVersion = '2.7.0') {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), 'weq-enhancement-updates-')));
  if (!existingRoot) roots.push(root);
  const config = new UserConfigService({ appDataRoot: () => root } as unknown as Platform);
  const base = release('old');
  const next = release('new');
  let active = base.contentVersion;
  let desired = base.contentVersion;
  const state: EnhancementComponentState = {
    ready: installed,
    sizeOnDisk: installed ? 96 : 0,
    downloadBytes: installed ? 0 : 96,
    identity: 'old',
    updateAvailable: false,
  };
  const ensure = vi.fn(async () => {
    active = desired;
    Object.assign(state, {
      ready: true,
      sizeOnDisk: 96,
      downloadBytes: 0,
      identity: active,
      updateAvailable: false,
    });
  });
  const component = {
    id: 'dress:index',
    state: () => state,
    ensure,
    select: () => {},
    remove: vi.fn(async () => {
      Object.assign(state, { ready: false, sizeOnDisk: 0, identity: '', updateAvailable: false });
    }),
  };
  component.select = vi.fn((...args: unknown[]) => {
    const selected = args[0] as (typeof next.components)[0];
    desired = releaseContentVersion([selected]);
    state.updateAvailable = state.ready && active !== desired;
    state.downloadBytes = active === desired && state.ready ? 0 : 96;
  });
  const packs = new EnhancementPacks(
    [
      {
        id: 'dress',
        name: '装扮',
        description: '',
        components: ['dress:index'],
        validate: vi.fn(async () => {}),
      },
    ],
    new Map([['dress:index', component]]),
    join(root, 'enhancements'),
  );
  let catalog = { schemaVersion: 1, target: 'any', packs: [next] };
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes('api.github.com')
            ? [
                {
                  tag_name: 'dress-new',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-14T00:00:00Z',
                  assets: [{ name: 'enhancement-pack.json' }],
                },
              ]
            : catalog,
        ),
      ),
  );
  const controller = new EnhancementUpdateController(packs, config, 'darwin-arm64', {
    currentVersion: () => currentVersion,
    nativeCommit: () => nativeCommit,
    fetcher: legacyFetch(fetcher),
  });
  controllers.push(controller);
  await controller.ready();
  if (installed) {
    packs.start(['dress'], false);
    await packs.wait();
  }
  return {
    config,
    root,
    state,
    packs,
    controller,
    ensure,
    select: component.select,
    fetcher,
    next,
    setLatest: (entry: typeof next) => {
      catalog = { ...catalog, packs: [entry] };
    },
  };
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.wait();
  }
  updateTransferPolicy('never', networkCost(false, false, 'test'));
  vi.useRealTimers();
  for (const task of [...backgroundTasks.snapshot()]) {
    backgroundTasks.resume(task.id);
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('首次手动下载自动读取在线清单，关闭自动检查也不使用本机基线地址', async () => {
  const f = await fixture(false);
  f.config.setSettings({ enhancementUpdates: { autoCheck: false } });
  f.packs.start(['dress']);
  await f.packs.wait();
  expect(f.fetcher).toHaveBeenCalled();
  expect(f.ensure).toHaveBeenCalledOnce();
  const [pack] = await f.packs.list();
  expect(pack?.installedVersion).toBe(f.next.contentVersion);
  expect(pack?.installedAt).toEqual(expect.any(Number));
  expect(pack?.updatedAt).toBeUndefined();
  const restarted = await fixture(false, f.root);
  expect((await restarted.packs.list())[0]?.installedAt).toBe(pack?.installedAt);
});

it('首次没有在线清单且断网时不开始组件下载，重试可重新取清单', async () => {
  const f = await fixture(false);
  f.fetcher.mockRejectedValueOnce(new Error('offline'));
  f.packs.start(['dress']);
  await f.packs.wait();
  expect(f.ensure).not.toHaveBeenCalled();
  expect((await f.packs.list())[0]?.operation).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('offline'),
  });
  f.packs.start(['dress']);
  await f.packs.wait();
  expect(f.ensure).toHaveBeenCalledOnce();
});

it('旧在线装扮索引清单可转换，缓存保存的是线上内容而非本机基线', async () => {
  const f = await fixture(false);
  const part = f.next.components[0]!;
  if (part.type !== 'dress') throw new Error('fixture');
  part.manifest.baseUrl = 'https://github.com/weq-devs/dress-resources/releases/download/dress-new';
  f.fetcher.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('api.github.com')
            ? [
                {
                  tag_name: 'dress-new',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-14T00:00:00Z',
                  assets: [
                    'index-manifest.json',
                    ...Object.values(part.manifest.parts).map((part) => part.asset),
                  ].map((name) => ({ name })),
                },
              ]
            : part.manifest,
        ),
      ),
  );
  await f.controller.check(['dress']);
  expect((await f.packs.list())[0]?.latestVersion).toBe(f.next.contentVersion);
  const cached = JSON.parse(await readFile(join(f.root, 'enhancements/checks.json'), 'utf8'));
  expect(cached.catalog.packs[0].contentVersion).toBe(f.next.contentVersion);
});

it('重启断网时复用已校验在线缓存，损坏缓存不能用来启动下载', async () => {
  const f = await fixture(false);
  await f.controller.check(['dress']);
  const restarted = await fixture(false, f.root);
  restarted.fetcher.mockRejectedValue(new Error('offline'));
  restarted.packs.start(['dress']);
  await restarted.packs.wait();
  expect(restarted.ensure).toHaveBeenCalledOnce();
  expect((await restarted.packs.list())[0]?.installedVersion).toBe(f.next.contentVersion);
  expect(restarted.controller.state('dress').phase).toBe('failed');
  const path = join(f.root, 'enhancements/checks.json');
  const cached = JSON.parse(await readFile(path, 'utf8'));
  cached.catalog.packs[0].contentVersion = '0'.repeat(64);
  await writeFile(path, JSON.stringify(cached));
  const damaged = await fixture(false, f.root);
  damaged.fetcher.mockRejectedValue(new Error('offline'));
  damaged.packs.start(['dress']);
  await damaged.packs.wait();
  expect(damaged.ensure).not.toHaveBeenCalled();
});

it('已有完整资源的离线核对不读取在线清单', async () => {
  const f = await fixture();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
  expect((await f.packs.list())[0]?.downloaded).toBe(true);
});

it('关闭自动安装时启动核对已有资源，不生成增强包已就绪任务，也不下载', async () => {
  const f = await fixture(false);
  Object.assign(f.state, { ready: true, sizeOnDisk: 96, downloadBytes: 0, identity: 'legacy' });
  f.config.setSettings({ enhancementUpdates: { autoCheck: false, autoUpdatePacks: [] } });
  f.packs.observePreparations((id, name) => {
    void trackEnhancementPreparation(f.packs, id, name).catch(() => {});
  });
  f.controller.start();
  await vi.waitFor(async () => expect((await f.packs.list())[0]?.ready).toBe(true));
  await f.packs.wait();
  expect(f.ensure).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot()).toEqual([]);
});

it('增强包原位进度和任务列表从启动起共用一条记录', async () => {
  const f = await fixture(false);
  const directory = join(f.root, 'enhancements');
  restoreEnhancementTasks(f.packs, directory);
  f.packs.observePreparations((id, name) => {
    void trackEnhancementPreparation(f.packs, id, name).catch(() => {});
  });
  await startEnhancementDownloads(f.packs, ['dress']);
  const tasks = backgroundTasks.snapshot();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.display?.action).toBe('安装增强包');
  const taskId = tasks[0]!.id;
  expect(enhancementDownloadTask(f.packs, 'dress')).toMatchObject({
    id: taskId,
    foreground: false,
  });
  await f.packs.wait();
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).not.toBe('running'));
  expect(backgroundTasks.snapshot()).toHaveLength(1);
  expect(backgroundTasks.snapshot()[0]?.foreground).toBe(false);
  expect(backgroundTasks.snapshot()[0]?.display).toEqual(tasks[0]?.display);
  // 模拟首次安装已记入旧任务，但整包回执尚无独立安装时间。
  const path = join(directory, 'ready.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.dress.installedAt;
  await writeFile(path, JSON.stringify(saved));
  const restarted = await fixture(false, f.root);
  restoreEnhancementTasks(restarted.packs, directory);
  expect((await restarted.packs.list())[0]?.installedAt).toBe(
    backgroundTasks.snapshot()[0]?.updatedAt,
  );
  expect(JSON.parse(await readFile(path, 'utf8')).dress.installedAt).toEqual(expect.any(Number));
});

it('重启找回暂停的增强包，自动安装只检查，手动继续才接回原任务', async () => {
  const first = await fixture();
  const firstDirectory = join(first.root, 'enhancements');
  restoreEnhancementTasks(first.packs, firstDirectory);
  const gate = Promise.withResolvers<void>();
  const ensure = first.ensure.getMockImplementation()!;
  first.ensure.mockImplementationOnce(async () => {
    await gate.promise;
    return ensure();
  });
  await startEnhancementDownloads(first.packs, ['dress'], { foreground: true });
  const id = backgroundTasks.snapshot()[0]!.id;
  await vi.waitFor(() => expect(first.ensure).toHaveBeenCalledOnce());
  await backgroundTasks.act(id, 'pause');
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).toBe('paused'));
  const saved = await readFile(join(firstDirectory, 'download-tasks.json'));
  await backgroundTasks.act(id, 'continue');
  gate.resolve();
  await first.packs.wait();
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).toBe('completed'));
  backgroundTasks.remove(id);

  const restarted = await fixture();
  restarted.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  const directory = join(restarted.root, 'enhancements');
  await writeFile(join(directory, 'download-tasks.json'), saved);
  restoreEnhancementTasks(restarted.packs, directory);
  expect(backgroundTasks.snapshot()[0]).toMatchObject({
    id,
    status: 'paused',
    foreground: false,
    display: { action: '更新增强包' },
  });
  await restarted.controller.check(['dress'], true);
  expect(restarted.ensure).not.toHaveBeenCalled();
  await startEnhancementDownloads(restarted.packs, ['dress']);
  await restarted.packs.wait();
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).toBe('completed'));
  expect(restarted.ensure).toHaveBeenCalledOnce();
  expect(backgroundTasks.snapshot()).toHaveLength(1);
  expect(forgetEnhancementTask(restarted.packs, id)).toBe(true);
  expect(JSON.parse(await readFile(join(directory, 'download-tasks.json'), 'utf8'))).toEqual({});
});

it('同版统一清单存在但损坏时不改读旧格式或更旧版本', async () => {
  const f = await fixture(false);
  f.fetcher.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('api.github.com')
            ? [
                {
                  tag_name: 'dress-new',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-14T00:00:00Z',
                  assets: ['enhancement-pack.json', 'index-manifest.json'].map((name) => ({
                    name,
                  })),
                },
                {
                  tag_name: 'dress-old',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-13T00:00:00Z',
                  assets: [{ name: 'enhancement-pack.json' }],
                },
              ]
            : { invalid: true },
        ),
      ),
  );
  await expect(f.controller.check(['dress'])).rejects.toThrow();
  expect(
    f.fetcher.mock.calls.every(
      ([url]) =>
        String(url).includes('api.github.com') ||
        String(url).includes('dress-new/enhancement-pack.json'),
    ),
  ).toBe(true);
  expect(f.ensure).not.toHaveBeenCalled();
  expect((await f.packs.list())[0]?.latestVersion).toBeNull();
});

it('旧在线装扮清单不能指向未发布或另一个 Release 的资产', async () => {
  const f = await fixture(false);
  const part = f.next.components[0]!;
  if (part.type !== 'dress') throw new Error('fixture');
  f.fetcher.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('api.github.com')
            ? [
                {
                  tag_name: 'dress-new',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-14T00:00:00Z',
                  assets: [{ name: 'index-manifest.json' }],
                },
              ]
            : part.manifest,
        ),
      ),
  );
  await expect(f.controller.check(['dress'])).rejects.toThrow('已发布资产');
  expect(f.select).not.toHaveBeenCalled();
});

it('当前检查已经成功时，旧的忙碌任务结束后自动安装已确认更新，不等待下一个周期', async () => {
  const f = await fixture();
  f.setLatest(release('old'));
  await f.controller.check(['dress']);
  f.config.setSettings({
    enhancementUpdates: { autoUpdatePacks: ['dress'] },
    updateCheckIntervalMinutes: -1,
  });
  f.controller.start();
  let finish = () => {};
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = f.ensure.getMockImplementation()!;
  f.ensure.mockImplementationOnce(async () => {
    await delayed;
    await original();
  });
  f.packs.start(['dress']);
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledTimes(1));
  f.setLatest(f.next);
  await f.controller.check(['dress'], true);
  expect(f.ensure).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledTimes(2));
  await f.packs.wait();
  expect((await f.packs.list())[0]?.installedVersion).toBe(f.next.contentVersion);
});

it('线上旧引擎清单可准备语音包，但拒绝清单中未实际发布的引擎文件', async () => {
  const f = await fixture(false);
  const target = 'darwin-arm64';
  const engineName = 'sherpa-published.tar.gz';
  const baseUrl = 'https://github.com/weq-devs/WeQ/releases/download/v2.7.0';
  const manifest = {
    schemaVersion: 1,
    target,
    engines: [
      {
        kind: 'sherpa',
        id: 'sherpa-published',
        compatibility: enhancementEngineCompatibility('sherpa'),
        target,
        url: `${baseUrl}/${engineName}`,
        sha256: sha('archive'),
        downloadBytes: 32,
        installedBytes: 8,
        files: [{ path: 'node_modules/runtime/index.js', size: 8, sha256: sha('runtime') }],
      },
    ],
  };
  const state = { ready: false, sizeOnDisk: 0, downloadBytes: 32, identity: '' };
  const ensure = vi.fn(async () => {
    state.ready = true;
    state.identity = 'online';
  });
  const select = vi.fn();
  const packs = new EnhancementPacks(
    [
      {
        id: 'voice',
        name: '语音',
        description: '',
        components: ['engine:sherpa', 'model:sensevoice'],
        validate: async () => {},
      },
    ],
    new Map(
      ['engine:sherpa', 'model:sensevoice'].map((id) => [
        id,
        {
          id,
          state: () => state,
          ensure,
          select,
          remove: async () => {},
        },
      ]),
    ),
    join(f.root, 'voice'),
  );
  const assetNames = [`enhancement-engines-${target}.json`, engineName];
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes('api.github.com')
            ? [
                {
                  tag_name: 'v2.7.0',
                  draft: false,
                  prerelease: false,
                  published_at: '2026-11-14T00:00:00Z',
                  assets: assetNames.map((name) => ({ name })),
                },
              ]
            : manifest,
        ),
      ),
  );
  const controller = new EnhancementUpdateController(packs, f.config, target, {
    currentVersion: () => '2.7.0',
    nativeCommit: () => nativeCommit,
    fetcher: legacyFetch(fetcher),
    legacyModels: VOICE_MODELS,
  });
  controllers.push(controller);
  packs.start(['voice']);
  await packs.wait();
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'engine', artifact: manifest.engines[0] }),
  );
  expect((await packs.list())[0]?.ready).toBe(true);
  assetNames.pop();
  await expect(controller.check(['voice'])).rejects.toThrow('已发布资产');
});

it('默认只自动检查，发现更新不安装；列表查询不触发下载或检查', async () => {
  const f = await fixture();
  expect(f.config.getSettings().enhancementUpdates).toEqual({
    autoCheck: true,
    autoUpdatePacks: [],
  });
  await f.packs.list();
  expect(f.fetcher).not.toHaveBeenCalled();
  await f.controller.check(['dress'], true);
  expect((await f.packs.list())[0]).toMatchObject({
    downloaded: true,
    updateAvailable: true,
    blocker: null,
  });
  expect(f.ensure).not.toHaveBeenCalled();
});
it.each(['当前渠道', '上次运行', '旧发布渠道'] as const)(
  '开启自动安装时只使用本次运行中当前渠道的检查结果（%s）',
  async (source) => {
    const checked = await fixture();
    const beta = release('beta');
    if (source === '旧发布渠道') {
      checked.config.setSettings({ updateCheckPrerelease: true });
      checked.setLatest(beta);
      checked.fetcher.mockResolvedValueOnce(
        Response.json([
          {
            tag_name: 'dress-beta',
            draft: false,
            prerelease: true,
            published_at: '2026-11-14T00:00:00Z',
            assets: [{ name: 'enhancement-pack.json' }],
          },
        ]),
      );
    }
    await checked.controller.check(['dress']);
    const f = source === '上次运行' ? await fixture(true, checked.root) : checked;
    f.config.setSettings({ updateCheckIntervalMinutes: -1, updateCheckPrerelease: false });
    f.controller.start();
    host.bootstrap = { userConfig: f.config, enhancements: { updates: f.controller } };
    const settings = router(enhancementProcedures).createCaller({});
    expect((await f.packs.list())[0]).toMatchObject({
      updateAvailable: true,
      latestVersion: source === '旧发布渠道' ? beta.contentVersion : f.next.contentVersion,
    });
    const notices = vi.fn();
    f.controller.subscribeNotifications(notices);
    notices.mockClear();
    f.fetcher.mockClear();
    await settings.setEnhancementUpdates({ pack: { id: 'dress', enabled: true } });
    await vi.waitFor(() => expect(notices).toHaveBeenLastCalledWith([]));
    if (source !== '当前渠道') {
      expect(backgroundTasks.snapshot()).toEqual([]);
      expect(f.ensure).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
      f.setLatest(f.next);
      await settings.checkEnhancementUpdates({ ids: ['dress'] });
    }
    await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledOnce());
    await f.packs.wait();
    expect((await f.packs.list())[0]?.installedVersion).toBe(f.next.contentVersion);
    expect(backgroundTasks.snapshot()).toMatchObject([{ automaticUpdate: true }]);
    if (source === '当前渠道') expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it('增强包按内容版本提醒，已提醒版本在 WeQ 升级后不重复提醒', async () => {
  const f = await fixture();
  const notices = vi.fn();
  const unsubscribe = f.controller.subscribeNotifications(notices);
  await f.controller.check(['dress'], true);
  const expected = [{ id: 'dress', name: '装扮', contentVersion: f.next.contentVersion }] as const;
  expect(notices).toHaveBeenLastCalledWith(expected);
  expect(backgroundTasks.snapshot()).toEqual([]);
  await f.controller.acknowledgeNotifications(expected);
  expect(notices).toHaveBeenLastCalledWith([]);
  await f.controller.check(['dress'], true);
  expect(notices).toHaveBeenLastCalledWith([]);
  unsubscribe();

  const upgraded = await fixture(true, f.root, '2.8.0');
  const nextNotices = vi.fn();
  upgraded.controller.subscribeNotifications(nextNotices);
  await upgraded.controller.check(['dress'], true);
  expect(nextNotices).toHaveBeenLastCalledWith([]);
  const next = release('newer');
  upgraded.setLatest(next);
  await upgraded.controller.check(['dress'], true);
  expect(nextNotices).toHaveBeenLastCalledWith([
    { id: 'dress', name: '装扮', contentVersion: next.contentVersion },
  ]);
});

it('另一端可在增强包安装、失败和删除后读取新状态，即使更新通知已确认', async () => {
  const f = await fixture();
  host.bootstrap = {
    userConfig: f.config,
    enhancements: { packs: f.packs, updates: f.controller, inspected: Promise.resolve() },
  };
  const api = router({ bootstrap: router(enhancementProcedures) });
  const desktop = api.createCaller({}).bootstrap;
  const remote = api.createCaller({ authorize: () => {} }).bootstrap;
  const events = await desktop.onEnhancementStateChanged();
  const snapshots: ReturnType<typeof desktop.enhancementPacks>[] = [];
  const state = vi.fn();
  const subscription = events.subscribe({
    next: (change) => {
      state(change);
      if (change.kind === 'resources' || change.kind === 'snapshot')
        snapshots.push(desktop.enhancementPacks());
    },
  });
  const notifications = vi.fn();
  const stopNotifications = f.controller.subscribeNotifications(notifications);
  try {
    expect(await snapshots[0]).toMatchObject({
      packs: [{ installed: true, fullDownloadBytes: null }],
    });
    await remote.setEnhancementUpdates({ autoCheck: false });
    expect(state).toHaveBeenLastCalledWith({ kind: 'preferences' });
    await remote.checkEnhancementUpdates({ ids: ['dress'] });
    expect(state).toHaveBeenLastCalledWith({ kind: 'check' });
    expect((await desktop.enhancementPacks()).packs[0]?.updateAvailable).toBe(true);
    await remote.acknowledgeEnhancementUpdates([
      { id: 'dress', contentVersion: f.next.contentVersion },
    ]);
    expect(notifications).toHaveBeenLastCalledWith([]);
    notifications.mockClear();

    f.ensure.mockRejectedValueOnce(new Error('download failed'));
    await remote.prepareEnhancementPacks({ ids: ['dress'] });
    await vi.waitFor(async () =>
      expect(await snapshots.at(-1)).toMatchObject({
        packs: [{ busy: false, updateAvailable: true, operation: { phase: 'failed' } }],
      }),
    );
    await remote.prepareEnhancementPacks({ ids: ['dress'] });
    await vi.waitFor(async () =>
      expect(await snapshots.at(-1)).toMatchObject({
        packs: [
          {
            ready: true,
            updateAvailable: false,
            installedVersion: f.next.contentVersion,
            fullDownloadBytes: 96,
            downloadBytes: 0,
          },
        ],
      }),
    );
    await remote.deleteEnhancementPack({ id: 'dress' });
    await vi.waitFor(async () =>
      expect(await snapshots.at(-1)).toMatchObject({
        packs: [{ installed: false, updateAvailable: false, busy: false }],
      }),
    );
    expect(notifications).not.toHaveBeenCalled();
  } finally {
    subscription.unsubscribe();
    stopNotifications();
  }
});

it('新订阅可取得尚未提醒的结果，旧弹窗确认不会清除新内容版本', async () => {
  const f = await fixture();
  await f.controller.check(['dress'], true);
  const notices = vi.fn();
  f.controller.subscribeNotifications(notices);
  await vi.waitFor(() =>
    expect(notices).toHaveBeenLastCalledWith([
      { id: 'dress', name: '装扮', contentVersion: f.next.contentVersion },
    ]),
  );
  const next = release('newer');
  f.setLatest(next);
  await f.controller.check(['dress'], true);
  await f.controller.acknowledgeNotifications([
    { id: 'dress', contentVersion: f.next.contentVersion },
  ]);
  expect(notices).toHaveBeenLastCalledWith([
    { id: 'dress', name: '装扮', contentVersion: next.contentVersion },
  ]);
});

it('等待两种发布来源检查完成后一次发布合并提醒，不提前逐包通知', async () => {
  const f = await fixture(false);
  const voice = createRelease('voice', [
    {
      type: 'engine',
      artifact: {
        kind: 'sherpa',
        id: 'sherpa-new',
        target: 'darwin-arm64',
        compatibility: enhancementEngineCompatibility('sherpa'),
        url: 'https://example.invalid/sherpa.tar.gz',
        sha256: sha('engine'),
        downloadBytes: 32,
        installedBytes: 8,
        files: [{ path: 'node_modules/runtime/index.js', size: 8, sha256: sha('runtime') }],
      },
    },
    modelReleaseComponent(VOICE_MODELS[0]!),
  ]);
  const definitions = [
    { id: 'voice' as const, name: '语音', components: ['engine:sherpa', 'model:sensevoice'] },
    { id: 'dress' as const, name: '装扮', components: ['dress:index'] },
  ].map((entry) => ({ ...entry, description: '', validate: async () => {} }));
  const packs = new EnhancementPacks(
    definitions,
    new Map(
      definitions.flatMap((pack) =>
        pack.components.map((id) => {
          const state = {
            ready: true,
            identity: 'old',
            downloadBytes: 32,
            sizeOnDisk: 32,
            updateAvailable: false,
          };
          return [
            id,
            {
              id,
              state: () => state,
              select: () => {
                state.updateAvailable = true;
              },
              ensure: async () => {},
              remove: async () => {},
            },
          ];
        }),
      ),
    ),
    join(f.root, 'combined'),
  );
  packs.start(['voice', 'dress'], false);
  await packs.wait();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    const dress = address.includes('dress-resources');
    const asset = dress ? 'enhancement-pack.json' : 'enhancement-packs-darwin-arm64.json';
    if (!address.includes('api.github.com') && dress) await waiting;
    return new Response(
      JSON.stringify(
        address.includes('api.github.com')
          ? [
              {
                tag_name: dress ? 'dress-new' : '2.7.0',
                draft: false,
                prerelease: false,
                published_at: '2026-11-14T00:00:00Z',
                assets: [{ name: asset }],
              },
            ]
          : { schemaVersion: 1, target: 'darwin-arm64', packs: [dress ? f.next : voice] },
      ),
    );
  });
  const controller = new EnhancementUpdateController(packs, f.config, 'darwin-arm64', {
    currentVersion: () => '2.7.0',
    nativeCommit: () => nativeCommit,
    fetcher: legacyFetch(fetcher),
  });
  controllers.push(controller);
  const notices = vi.fn();
  controller.subscribeNotifications(notices);
  const checking = controller.check(['voice', 'dress'], true);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(8));
    expect(notices).toHaveBeenCalledTimes(1);
    expect(notices).toHaveBeenLastCalledWith([]);
  } finally {
    finish();
    await checking;
  }
  expect(notices).toHaveBeenCalledTimes(2);
  expect(notices).toHaveBeenLastCalledWith([
    { id: 'voice', name: '语音', contentVersion: voice.contentVersion },
    { id: 'dress', name: '装扮', contentVersion: f.next.contentVersion },
  ]);
  expect(backgroundTasks.snapshot()).toEqual([]);
});

it.each(['uninstalled', 'unchanged', 'repair', 'incompatible', 'automatic'] as const)(
  '%s 不产生增强包更新弹窗提醒',
  async (scenario) => {
    const f = await fixture(scenario !== 'uninstalled');
    if (scenario === 'unchanged' || scenario === 'repair') f.setLatest(release('old'));
    if (scenario === 'repair') {
      await f.controller.check(['dress']);
      f.packs.start(['dress']);
      await f.packs.wait();
      Object.assign(f.state, { ready: false, downloadBytes: 96 });
    }
    if (scenario === 'incompatible') f.setLatest(release('future', '3.0.0'));
    if (scenario === 'automatic')
      f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
    const notices = vi.fn();
    f.controller.subscribeNotifications(notices);
    await f.controller.check(['dress'], true);
    expect(notices).toHaveBeenLastCalledWith([]);
    await f.packs.wait();
  },
);

it('旧缓存迁移以已知内容为基线，不因升级 WeQ 再次提醒', async () => {
  const f = await fixture();
  await f.controller.check(['dress'], true);
  const path = join(f.root, 'enhancements/checks.json');
  const cached = JSON.parse(await readFile(path, 'utf8'));
  delete cached.notifiedVersions;
  await writeFile(path, JSON.stringify(cached));
  const upgraded = await fixture(true, f.root, '2.8.0');
  const notices = vi.fn();
  upgraded.controller.subscribeNotifications(notices);
  await upgraded.controller.check(['dress'], true);
  expect(notices).toHaveBeenLastCalledWith([]);
});
it.each([false, true])(
  '更新检查不登记任务，合并在途请求并保留结果（自动：%s）',
  async (automatic) => {
    const f = await fixture();
    const fetch = f.fetcher.getMockImplementation()!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.fetcher.mockImplementationOnce(async (url) => {
      await waiting;
      return fetch(url);
    });
    const checking = f.controller.check(['dress'], automatic);
    const repeated = f.controller.check(['dress'], automatic);
    expect(repeated).toBe(checking);
    try {
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      expect(f.controller.state('dress').phase).toBe('checking');
      expect(backgroundTasks.snapshot()).toEqual([]);
    } finally {
      release();
      await checking;
    }
    expect(f.controller.state('dress')).toMatchObject({
      phase: 'checked',
      checkedAt: expect.any(Number),
    });
    expect((await f.packs.list())[0]?.updateAvailable).toBe(true);
    expect(backgroundTasks.snapshot()).toEqual([]);
  },
);
it('自动检查收尾期间刷新网络策略，不会把已完成的检查改回进行中', async () => {
  const f = await fixture();
  const list = f.packs.list.bind(f.packs);
  const notices = vi.fn();
  f.controller.subscribeNotifications(notices);
  vi.spyOn(f.packs, 'list').mockImplementationOnce(async () => {
    expect(f.controller.state('dress').phase).toBe('checked');
    updateTransferPolicy('never', networkCost(false, false, 'test'));
    return list();
  });

  await f.controller.check(['dress'], true);

  expect(f.controller.state('dress')).toMatchObject({
    phase: 'checked',
    checkedAt: expect.any(Number),
  });
  expect(notices).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'dress' })]);
});
it.each([false, true])(
  '更新检查失败不登记任务，保留错误并允许原位重试（自动：%s）',
  async (automatic) => {
    const f = await fixture();
    f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(f.controller.check(['dress'], automatic)).rejects.toThrow('offline');
    expect(f.controller.state('dress')).toMatchObject({ phase: 'failed', error: 'offline' });
    expect(backgroundTasks.snapshot()).toEqual([]);
    await f.controller.check(['dress'], automatic);
    expect(f.controller.state('dress').phase).toBe('checked');
    expect(f.controller.state('dress').error).toBeUndefined();
    expect(backgroundTasks.snapshot()).toEqual([]);
  },
);
it('自动安装已安装的更新，登记任务，未安装或明确删除的包不自动安装', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  await f.controller.check(['dress'], true);
  await f.packs.wait();
  expect(f.ensure).toHaveBeenCalledTimes(1);
  expect(backgroundTasks.snapshot()).toMatchObject([{ name: '装扮', automaticUpdate: true }]);
  const empty = await fixture(false);
  empty.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  await empty.controller.check(['dress'], true);
  expect(empty.ensure).not.toHaveBeenCalled();
  await f.packs.remove('dress');
  f.setLatest(release('next'));
  await f.controller.check(['dress'], true);
  expect(f.ensure).toHaveBeenCalledTimes(1);
});
it('迁移旧总开关时只启用当时已安装的包，并清除旧设置', async () => {
  const installed = await fixture();
  const empty = await fixture(false);
  for (const f of [installed, empty]) {
    f.config.setSettings({ enhancementUpdates: { autoCheck: false, autoInstall: true } });
    await f.controller.ready();
    expect(f.config.getSettings().enhancementUpdates).toEqual({
      autoCheck: false,
      autoUpdatePacks: f === installed ? ['dress'] : [],
    });
  }
});
it('只有选中的包才自动更新，手动更新写入时间，失败和重启均保留时间', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['voice'] } });
  await f.controller.check(['dress'], true);
  expect(f.ensure).not.toHaveBeenCalled();
  expect((await f.packs.list())[0]?.updatedAt).toBeUndefined();
  await startEnhancementDownloads(f.packs, ['dress'], { mode: 'download' });
  expect(f.ensure).not.toHaveBeenCalled();
  await startEnhancementDownloads(f.packs, ['dress'], { mode: 'update' });
  await f.packs.wait();
  const updatedAt = (await f.packs.list())[0]?.updatedAt;
  expect(updatedAt).toEqual(expect.any(Number));
  f.setLatest(release('next'));
  f.ensure.mockRejectedValueOnce(new Error('offline'));
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  await f.controller.check(['dress'], true);
  await f.packs.wait();
  expect((await f.packs.list())[0]?.updatedAt).toBe(updatedAt);
  const restarted = await fixture(false, f.root);
  expect((await restarted.packs.list())[0]?.updatedAt).toBe(updatedAt);
});
it('自动更新任务仅在失败或需要继续时提醒，成功仍可查看历史', () => {
  const tracker = new TaskNotificationTracker();
  const update = (status: 'running' | 'paused' | 'completed' | 'failed', statusLabel?: string) => {
    const summary = summarizeWorkspaceTasks({
      background: [
        { id: 'pack', kind: 'model', automaticUpdate: true, updatedAt: 1, status, statusLabel },
      ],
    });
    return {
      summary,
      events: tracker
        .update('test', summary.items, true)
        .map(({ event }) => event)
        .filter(Boolean),
    };
  };
  tracker.update('test', [], true);
  const running = update('running');
  expect(running.summary.running).toBe(0);
  expect(running.events).toEqual([]);
  expect(update('paused', '省流量模式已暂停').events).toEqual([]);
  expect(update('paused', '等待继续').events).toEqual(['taskFailure']);
  expect(update('running').events).toEqual([]);
  const completed = update('completed');
  expect(completed.summary.items[0]?.activity).toBe('finished');
  expect(completed.summary.finished).toBe(0);
  expect(completed.events).toEqual([]);
  expect(update('running').events).toEqual([]);
  const failed = update('failed');
  expect(failed.summary.failed).toBe(1);
  expect(failed.events).toEqual(['taskFailure']);
});
it('最新最低版本过高只提示，不回退到较旧兼容更新；最低版本相等可用', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  f.setLatest(release('future', '3.0.0'));
  await f.controller.check(['dress'], true);
  expect((await f.packs.list())[0]).toMatchObject({
    downloaded: true,
    requiresWeqUpdate: true,
    minWeqVersion: '3.0.0',
  });
  expect(f.ensure).not.toHaveBeenCalled();
  expect(enhancementReleaseBlocker(release('same', '2.7.0'), '2.7.0', nativeCommit)).toBeNull();
});
it('已安装包升级后缺项：默认等待一键补齐，自动安装开启后才补齐', async () => {
  const f = await fixture();
  Object.assign(f.state, { ready: false, sizeOnDisk: 32, downloadBytes: 64 });
  await f.controller.check(['dress'], true);
  expect((await f.packs.list())[0]).toMatchObject({
    installed: true,
    downloaded: false,
    needsRepair: true,
    updateAvailable: true,
  });
  expect(f.ensure).not.toHaveBeenCalled();
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  await f.controller.check(['dress'], true);
  await f.packs.wait();
  expect(f.ensure).toHaveBeenCalledOnce();
  expect((await f.packs.list())[0]).toMatchObject({ ready: true, needsRepair: false });
});

it('关闭自动设置不会停止已经启动的补齐任务', async () => {
  const f = await fixture();
  Object.assign(f.state, { ready: false, sizeOnDisk: 32, downloadBytes: 64 });
  let finish = () => {};
  const original = f.ensure.getMockImplementation()!;
  f.ensure.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await original();
  });
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  await f.controller.check(['dress'], true);
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledOnce());
  f.config.setSettings({ enhancementUpdates: { autoCheck: false, autoUpdatePacks: [] } });
  finish();
  await f.packs.wait();
  expect((await f.packs.list())[0]).toMatchObject({ ready: true, needsRepair: false });
});
it('运行接口和 native 密钥各自验证，不以最低版本代替可读性', () => {
  const entry = release('other');
  expect(enhancementReleaseBlocker(entry, '2.7.0', 'b'.repeat(40))).toContain('原生模块');
  expect(
    enhancementReleaseBlocker({ ...entry, runtime: 'ntdr-v2' }, '2.7.0', nativeCommit),
  ).toContain('运行接口');
  expect(() =>
    parseEnhancementCatalog({ schemaVersion: 2, target: 'darwin-arm64', packs: [entry] }),
  ).toThrow();
});
it('旧客户端先读取最低版本，即使新版同时增加未知模型和清单格式也能提示更新 WeQ', () => {
  const entry = release('future', '3.0.0');
  const catalog = parseEnhancementCatalogForHost(
    {
      schemaVersion: 2,
      target: 'darwin-arm64',
      packs: [{ ...entry, components: [{ type: 'model', id: 'future-model', files: [] }] }],
    },
    '2.7.0',
    'darwin-arm64',
  );
  expect(catalog.packs[0]?.components).toEqual([]);
  expect(enhancementReleaseBlocker(catalog.packs[0]!, '2.7.0', nativeCommit)).toBe(
    '需先更新 WeQ 至 v3.0.0',
  );
});
it('旧文字识别发布清单仍可准备新版模型，沿用同一引擎和筛图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-ocr-release-'));
  roots.push(root);
  const directory = join(root, 'enhancements');
  await mkdir(directory);
  const target = 'darwin-arm64';
  const engine = {
    type: 'engine' as const,
    artifact: {
      kind: 'onnx' as const,
      id: 'old-onnx',
      name: 'engine.tar.gz',
      compatibility: enhancementEngineCompatibility('onnx'),
      target,
      url: 'https://example.invalid/engine.tar.gz',
      sha256: sha('archive'),
      downloadBytes: 32,
      installedBytes: 8,
      files: [{ path: 'node_modules/runtime/index.js', size: 8, sha256: sha('runtime') }],
    },
  };
  const [recognition, filter] = OCR_MODELS.map(modelReleaseComponent);
  const old = createRelease('text', [
    engine,
    modelReleaseComponent(getOcrModel('ppocr-v5-mobile')!),
    filter!,
  ]);
  const upgraded = createRelease('text', [engine, recognition!, filter!]);
  const catalog = (entry: typeof old) => ({ schemaVersion: 1, target, packs: [entry] });
  expect(
    parseEnhancementCatalogForHost(catalog(upgraded), '2.8.0-beta.1', target).packs[0],
  ).toMatchObject({ components: upgraded.components });
  expect(parseEnhancementCatalogForHost(catalog(upgraded), '2.7.5', target).packs[0]).toMatchObject(
    { unavailable: '需先更新 WeQ 至 v2.8.0-beta.1', components: [] },
  );
  await writeFile(join(directory, 'checks.json'), JSON.stringify({ catalog: catalog(old) }));
  const ids = ['engine:onnx', 'model:ppocr-v6-small', 'model:ppocr-v6-det-tiny'];
  const select = vi.fn();
  const packs = new EnhancementPacks(
    [{ id: 'text', name: '文字识别', description: '', components: ids, validate: async () => {} }],
    new Map(
      ids.map((id) => [
        id,
        {
          id,
          state: () => ({ ready: false, sizeOnDisk: 0, downloadBytes: 0, identity: '' }),
          select,
          ensure: async () => {},
          remove: async () => {},
        },
      ]),
    ),
    directory,
  );
  const config = new UserConfigService({ appDataRoot: () => root } as unknown as Platform);
  const controller = new EnhancementUpdateController(packs, config, target, {
    currentVersion: () => '2.8.0-beta.1',
    nativeCommit: () => undefined,
    legacyModels: OCR_MODELS,
  });
  controllers.push(controller);
  await controller.ready();
  expect(select.mock.calls.map(([component]) => component)).toEqual(upgraded.components);
  expect((await packs.list())[0]).toMatchObject({
    blocker: null,
    latestVersion: upgraded.contentVersion,
  });
});
it('Release 标签或下载源变化不改变内容版本', () => {
  const a = release('same');
  const b = structuredClone(a);
  const component = b.components[0]!;
  if (component.type === 'dress') {
    component.manifest.tag = 'dress-mirror';
    component.manifest.baseUrl = 'https://example.invalid/mirror';
  }
  expect(releaseContentVersion(b.components)).toBe(a.contentVersion);
});
it('检查失败保留旧安装与失败状态，不报告最新或自动下载', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoUpdatePacks: ['dress'] } });
  f.fetcher.mockRejectedValue(new Error('offline'));
  await expect(f.controller.check(['dress'], true)).rejects.toThrow('offline');
  expect(f.controller.state('dress')).toMatchObject({ phase: 'failed', error: 'offline' });
  expect((await f.packs.list())[0]?.downloaded).toBe(true);
  expect(f.ensure).not.toHaveBeenCalled();
});
it('省流量暂停后台检查；手动继续解除本次暂停而不改全局设置', async () => {
  const f = await fixture();
  updateTransferPolicy('always', networkCost(true, true, 'test'));
  const task = f.controller.check(['dress'], true);
  await vi.waitFor(() => expect(f.controller.state('dress').phase).toBe('waiting-network'));
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot()).toEqual([]);
  await f.controller.check(['dress']);
  await task;
  expect(f.fetcher).toHaveBeenCalled();
  expect(f.controller.state('dress').phase).toBe('checked');
  expect(backgroundTasks.snapshot()).toEqual([]);
  expect(f.config.getSettings().enhancementUpdates.autoUpdatePacks).toEqual([]);
});
it('自动检查跟随软件更新频率，永不与关闭开关停止定时检查', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.config.setSettings({ updateCheckIntervalMinutes: -1 });
  f.controller.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.config.setSettings({ updateCheckIntervalMinutes: 1 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.fetcher).toHaveBeenCalled();
  const calls = f.fetcher.mock.calls.length;
  f.config.setSettings({ enhancementUpdates: { autoCheck: false } });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
});
