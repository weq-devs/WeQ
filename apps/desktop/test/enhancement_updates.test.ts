// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';
import { EnhancementUpdateController } from '../src/main/enhancements/updates';
import { EnhancementPacks, type EnhancementComponentState } from '../src/main/enhancements/packs';
import { createRelease, releaseContentVersion } from '../src/main/enhancements/release_catalog';
import {
  enhancementReleaseBlocker,
  parseEnhancementCatalog,
  parseEnhancementCatalogForHost,
} from '../src/shared/enhancement_release';
import { backgroundTasks } from '../src/main/background_tasks';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { networkCost } from '@weq/service/data-saver';

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
async function fixture(installed = true) {
  const root = await mkdtemp(join(tmpdir(), 'weq-enhancement-updates-'));
  roots.push(root);
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
  const controller = new EnhancementUpdateController(
    packs,
    config,
    { schemaVersion: 1, target: 'darwin-arm64', packs: [base] },
    { currentVersion: () => '2.7.0', nativeCommit: () => nativeCommit, fetcher },
  );
  controllers.push(controller);
  await controller.ready();
  if (installed) {
    packs.start(['dress'], false);
    await packs.wait();
  }
  return {
    config,
    state,
    packs,
    controller,
    ensure,
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

it('当前检查已经成功时，旧的忙碌任务结束后自动安装已确认更新，不等待下一个周期', async () => {
  const f = await fixture();
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
  await f.controller.check(['dress'], true);
  expect(f.ensure).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledTimes(2));
  await f.packs.wait();
  expect((await f.packs.list())[0]?.installedVersion).toBe(f.next.contentVersion);
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
it('自动安装已安装的更新，登记任务，未安装或明确删除的包不自动安装', async () => {
  const f = await fixture();
  f.config.setSettings({ enhancementUpdates: { autoInstall: true } });
  await f.controller.check(['dress'], true);
  await f.packs.wait();
  expect(f.ensure).toHaveBeenCalledTimes(1);
  expect(backgroundTasks.snapshot().some((task) => task.name === '装扮')).toBe(true);
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
  await f.controller.check(['dress']);
  await task;
  expect(f.fetcher).toHaveBeenCalled();
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
