// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserConfigService } from '@weq/service';
const context = vi.hoisted(() => ({
  root: '',
  uin: '10001',
  configId: '10001_aabbccdd',
  config: null as UserConfigService | null,
  assistantSessions: [] as Array<{ id: string }>,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: context.configId }) },
    fileResource: { trustPath: vi.fn() },
    assistant: { listSessions: () => context.assistantSessions },
  };
  return {
    requirePlatform: () => ({ appDataRoot: () => context.root }),
    requireBootstrap: () => ({
      userConfig: context.config,
    }),
    getAppContext: () => ({ account: { context: { uin: context.uin } }, services }),
  };
});
import { clientStateRouter, boundClientState } from '../src/main/ipc/routers/client_state';
import { createWebHost } from '../src/main/web/host';
import { getAppContext } from '../src/main/context/app_context';
import { pickedBrowserFiles } from '../src/main/browser_files';
beforeEach(() => {
  context.root = mkdtempSync(join(tmpdir(), 'weq-sync-router-'));
  context.uin = '10001';
  context.configId = '10001_aabbccdd';
  context.config = new UserConfigService({ appDataRoot: () => context.root });
  context.assistantSessions = [];
});
afterEach(() => rmSync(context.root, { recursive: true, force: true }));
it('助手永久删除后的迟到草稿写入不能恢复内容，不影响未删除会话', async () => {
  const client = clientStateRouter.createCaller({});
  const binding = { expectedAccountUin: context.uin, expectedAccountConfigId: context.configId };
  context.assistantSessions = [{ id: 'selected' }, { id: 'unselected' }];
  const saved = await client.saveDraft({
    ...binding,
    key: 'assistant:selected',
    value: '原草稿',
    expectedVersion: null,
  });
  context.assistantSessions = [{ id: 'unselected' }];
  boundClientState(binding).observeDraft('assistant:selected', null);
  await expect(
    client.saveDraft({
      ...binding,
      key: 'assistant:selected',
      value: '迟到草稿',
      expectedVersion: saved.current.version,
    }),
  ).rejects.toThrow('已删除');
  expect((await client.draft({ ...binding, key: 'assistant:selected' })).value).toBeNull();
  await expect(
    client.saveDraft({
      ...binding,
      key: 'assistant:unselected',
      value: '继续输入',
      expectedVersion: null,
    }),
  ).resolves.toMatchObject({ ok: true });
});
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
  ).toEqual({ order: {} });
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
