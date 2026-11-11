// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const context = vi.hoisted(() => ({
  root: '',
  uin: '10001',
  configId: '10001_aabbccdd',
  settings: { showMessageBubble: true },
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: context.configId }) },
    fileResource: { trustPath: vi.fn() },
  };
  return {
    requirePlatform: () => ({ appDataRoot: () => context.root }),
    requireBootstrap: () => ({
      userConfig: {
        getSettings: () => context.settings,
        setSettings: (value: object) => {
          Object.assign(context.settings, value);
        },
      },
    }),
    getAppContext: () => ({ account: { context: { uin: context.uin } }, services }),
  };
});
import { clientStateRouter } from '../src/main/ipc/routers/client_state';
import { createWebHost } from '../src/main/web/host';
import { getAppContext } from '../src/main/context/app_context';
import { pickedBrowserFiles } from '../src/main/browser_files';
beforeEach(() => {
  context.root = mkdtempSync(join(tmpdir(), 'weq-sync-router-'));
  context.uin = '10001';
  context.configId = '10001_aabbccdd';
  context.settings.showMessageBubble = true;
});
afterEach(() => rmSync(context.root, { recursive: true, force: true }));
it('手机不能自动提交旧值为共享初值；显式修改和桌面补缺保持最后提交值', async () => {
  const desktop = clientStateRouter.createCaller({});
  const mobile = clientStateRouter.createCaller({
    host: createWebHost({ exportDir: join(context.root, 'exports'), version: 'fixture' }),
  });
  await expect(mobile.seed({ background: 'grid' })).rejects.toThrow('桌面');
  await mobile.patch({ background: 'dots' });
  await desktop.seed({ background: 'paper', accent: '#123456' });
  expect((await mobile.snapshot()).values).toMatchObject({ background: 'dots', accent: '#123456' });
});
it('同号不同配置隔离，旧账号绑定不能写入新配置', async () => {
  const client = clientStateRouter.createCaller({});
  const old = { expectedAccountUin: context.uin, expectedAccountConfigId: context.configId };
  await client.accountPatch({ ...old, namespace: 'pins', values: { '123': true } });
  context.configId = '10001_11223344';
  await expect(client.accountSnapshot(old)).rejects.toThrow('已切换');
  await expect(
    client.accountPatch({ ...old, namespace: 'pins', values: { '123': false } }),
  ).rejects.toThrow('已切换');
  expect(
    (await client.accountSnapshot({ ...old, expectedAccountConfigId: context.configId })).records,
  ).toEqual({});
});
it('复用真实分段接收后转存素材，临时接收目录丢弃后持久副本仍可读取', async () => {
  const services = getAppContext().services!;
  const bytes = Buffer.from('synthetic image bytes');
  const upload = await pickedBrowserFiles.start(services, bytes.length, 'photo.png');
  try {
    await pickedBrowserFiles.append(services, upload.id, 0, bytes);
    const result = await clientStateRouter.createCaller({}).keepDraftMedia({
      expectedAccountUin: context.uin,
      expectedAccountConfigId: context.configId,
      uploadId: upload.id,
    });
    await pickedBrowserFiles.discard(services, upload.id);
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(result.path).toContain(join('config', 'accounts', context.configId, 'draft-media'));
  } finally {
    await pickedBrowserFiles.discard(services, upload.id);
  }
});
