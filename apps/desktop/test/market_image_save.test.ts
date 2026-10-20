import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MsgService } from '@weq/service';
import { marketEmojiRouter } from '../src/main/ipc/routers/market_emoji';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  services: {} as object,
  image: vi.fn(async (_pack: string, _hash: string): Promise<string | null> => null),
  register: vi.fn((_path: string, _name: string, _kind: string) => ({ url: '/download/fixture' })),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({ registerDownload: state.register }),
}));
let root: string, source: string, manager: ExportTaskManager;
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  packId: '123',
  hash: 'abcdef0123456789',
  name: '合成表情',
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-market-save-'));
  source = join(root, 'original.gif');
  writeFileSync(source, 'GIF89a-synthetic');
  manager = new ExportTaskManager({} as MsgService, join(root, 'tasks'));
  state.configId = 'source-a';
  state.image.mockReset().mockResolvedValue(source);
  state.register.mockClear();
  state.services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    emoji: { getMarketPackImage: state.image },
    exportManager: manager,
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('只获取所选单张 GIF，使用公共任务保存且不覆盖同名原件', async () => {
  const target = join(root, 'chosen.gif');
  writeFileSync(target, 'personal');
  const id = await marketEmojiRouter.createCaller({}).startImageSave({
    ...input,
    savePolicy: { mode: 'preset', filePath: target, uniqueFileName: true },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.save?.status).toBe('saved'));
  const task = manager.getTask(id)!;
  expect(state.image).toHaveBeenCalledOnce();
  expect(state.image).toHaveBeenCalledWith(input.packId, input.hash);
  expect(task.resource?.output).toEqual({ kind: 'file', name: input.name, extension: 'gif' });
  expect(readFileSync(task.save!.path!, 'utf8')).toBe('GIF89a-synthetic');
  expect(readFileSync(target, 'utf8')).toBe('personal');
  expect(readFileSync(source, 'utf8')).toBe('GIF89a-synthetic');
});
it('稍后保存保留单文件结果，资源不可用则明确失败', async () => {
  const api = marketEmojiRouter.createCaller({});
  const id = await api.startImageSave({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  expect(manager.getTask(id)?.save?.status).toBe('pending');
  expect(manager.getTask(id)?.bundleDir).toBeUndefined();
  state.image.mockResolvedValueOnce(null);
  const missing = await api.startImageSave({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(missing)?.status).toBe('failed'));
  expect(manager.getTask(missing)?.error).toContain('不可用');
});
it('浏览器下载只注册现有单张缓存，不创建服务器保存任务', async () => {
  expect(await marketEmojiRouter.createCaller({}).downloadImage(input)).toEqual({
    url: '/download/fixture',
  });
  expect(state.register).toHaveBeenCalledWith(source, '合成表情.gif', 'file');
  expect(manager.listTasks()).toEqual([]);
});
it('取图期间切换来源不发布迟到结果，旧来源也不能创建任务', async () => {
  state.image.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return source;
  });
  await expect(marketEmojiRouter.createCaller({}).downloadImage(input)).rejects.toThrow(
    '数据源已切换',
  );
  expect(state.register).not.toHaveBeenCalled();
  await expect(
    marketEmojiRouter.createCaller({}).startImageSave({ ...input, savePolicy: { mode: 'after' } }),
  ).rejects.toThrow('数据源已切换');
  expect(manager.listTasks()).toEqual([]);
});
