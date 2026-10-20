import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MsgService } from '@weq/service';
import { dressupRouter } from '../src/main/ipc/routers/dressup';
const state = vi.hoisted(() => ({
  configId: 'source-a',
  services: {} as object,
  selected: '' as string | null,
  root: '',
  web: false,
  pick: vi.fn(async (_input: unknown) => ({
    path: state.selected!,
    downloadId: state.web ? 'fixture-download' : null,
  })),
  build: vi.fn(async (_services: unknown, _ids: unknown, _kind?: string) => ({
    fileName: 'WeQ-字体-11.ttf',
    bytes: Buffer.from('fixture-resource'),
    kind: 'font' as const,
  })),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
vi.mock('../src/main/ipc/routers/dressup_export', () => ({
  buildDecorationFile: state.build,
  buildDecorationBundle: state.build,
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({
    exportRoot: state.web ? state.root : undefined,
    registerDownload: () => ({ url: '/download' }),
    pickSaveTarget: async (input: unknown) => (state.selected ? state.pick(input) : null),
    pickDirectory: async () => state.root,
  }),
}));
let manager: ExportTaskManager;
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  fontId: 11,
  kind: 'font' as const,
};
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-dress-save-'));
  state.configId = 'source-a';
  state.web = false;
  state.selected = join(state.root, 'chosen.ttf');
  state.pick.mockClear();
  state.build.mockReset().mockResolvedValue({
    fileName: 'WeQ-字体-11.ttf',
    bytes: Buffer.from('fixture-resource'),
    kind: 'font',
  });
  manager = new ExportTaskManager({} as MsgService, join(state.root, 'tasks'));
  state.services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    exportManager: manager,
  };
});
afterEach(() => rmSync(state.root, { recursive: true, force: true }));
it.each(['ttf', 'png', 'zip'])('根据实际 %s 产物打开公共单文件选择器', async (extension) => {
  state.build.mockResolvedValueOnce({
    fileName: `真实产物.${extension}`,
    bytes: Buffer.from('fixture-resource'),
    kind: 'font',
  });
  state.selected = join(state.root, `chosen.${extension}`);
  const result = await dressupRouter
    .createCaller({})
    .saveMsgDecoration({ ...input, savePolicy: { mode: 'before' } });
  expect(result.mode).toBe('task');
  if (result.mode !== 'task') throw new Error('应创建任务');
  expect(state.pick).toHaveBeenCalledWith({ defaultName: `真实产物.${extension}`, extension });
  await vi.waitFor(() => expect(manager.getTask(result.taskId)?.save?.status).toBe('saved'));
  expect(readFileSync(state.selected!, 'utf8')).toBe('fixture-resource');
});
it('取消公共选择器不创建任务，稍后保存不弹选择器', async () => {
  state.selected = null;
  const api = dressupRouter.createCaller({});
  expect(await api.saveMsgDecoration({ ...input, savePolicy: { mode: 'before' } })).toEqual({
    mode: 'cancelled',
  });
  expect(manager.listTasks()).toEqual([]);
  const result = await api.saveMsgDecoration({ ...input, savePolicy: { mode: 'after' } });
  if (result.mode !== 'task') throw new Error('应创建任务');
  await vi.waitFor(() => expect(manager.getTask(result.taskId)?.status).toBe('completed'));
  expect(manager.getTask(result.taskId)?.save?.status).toBe('pending');
});
it('保存失败保留完整缓存，不覆盖已有文件', async () => {
  writeFileSync(state.selected!, 'personal');
  const result = await dressupRouter
    .createCaller({})
    .saveMsgDecoration({ ...input, savePolicy: { mode: 'before' } });
  if (result.mode !== 'task') throw new Error('应创建任务');
  await vi.waitFor(() => expect(manager.getTask(result.taskId)?.save?.status).toBe('failed'));
  expect(readFileSync(state.selected!, 'utf8')).toBe('personal');
  expect(readFileSync(manager.getTask(result.taskId)!.filePath!, 'utf8')).toBe('fixture-resource');
});
it('解析期间切换来源，不打开旧来源的选择器或创建任务', async () => {
  state.build.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return { fileName: 'x.ttf', bytes: Buffer.from('fixture'), kind: 'font' };
  });
  await expect(
    dressupRouter.createCaller({}).saveMsgDecoration({ ...input, savePolicy: { mode: 'before' } }),
  ).rejects.toThrow('数据源已切换');
  expect(state.pick).not.toHaveBeenCalled();
  expect(manager.listTasks()).toEqual([]);
});
it('Web 浏览器下载与服务器任务分离，使用已有输出格式', async () => {
  state.web = true;
  expect(
    await dressupRouter.createCaller({}).saveMsgDecoration({ ...input, browserDownload: true }),
  ).toEqual({ mode: 'browser', downloadId: 'fixture-download', name: 'WeQ-字体-11.ttf' });
  expect(manager.listTasks()).toEqual([]);
  expect(readFileSync(state.selected!, 'utf8')).toBe('fixture-resource');
});
