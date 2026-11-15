// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Platform } from '@weq/platform';
import { UserConfigService, VOICE_MODELS } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';
import { EnhancementUpdateController } from '../src/main/enhancements/updates';
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
import { trackEnhancementPreparation } from '../src/main/enhancements/tasks';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { networkCost } from '@weq/service/data-saver';
import { enhancementEngineCompatibility } from '../src/shared/enhancement_manifest';

const roots: string[] = [];
const controllers: EnhancementUpdateController[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const nativeCommit = 'a'.repeat(40);
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
    fetcher,
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
  expect((await f.packs.list())[0]?.installedVersion).toBe(f.next.contentVersion);
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
  f.config.setSettings({ enhancementUpdates: { autoCheck: false, autoInstall: false } });
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
    enhancementUpdates: { autoInstall: true },
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
    fetcher,
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
    autoInstall: false,
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
    fetcher,
  });
  controllers.push(controller);
  const notices = vi.fn();
  controller.subscribeNotifications(notices);
  const checking = controller.check(['voice', 'dress'], true);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
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
      f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
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
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
  await f.controller.check(['dress'], true);
  await f.packs.wait();
  expect(f.ensure).toHaveBeenCalledTimes(1);
  expect(backgroundTasks.snapshot().map((task) => task.name)).toEqual(['装扮']);
  const empty = await fixture(false);
  empty.config.setSettings({ enhancementUpdates: { autoInstall: true } });
  await empty.controller.check(['dress'], true);
  expect(empty.ensure).not.toHaveBeenCalled();
  await f.packs.remove('dress');
  f.setLatest(release('next'));
  await f.controller.check(['dress'], true);
  expect(f.ensure).toHaveBeenCalledTimes(1);
});
it('最新最低版本过高只提示，不回退到较旧兼容更新；最低版本相等可用', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
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
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
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
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
  await f.controller.check(['dress'], true);
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledOnce());
  f.config.setSettings({ enhancementUpdates: { autoCheck: false, autoInstall: false } });
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
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
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
  expect(f.config.getSettings().enhancementUpdates.autoInstall).toBe(false);
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
