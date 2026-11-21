// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, readZipEntries, type MsgService } from '@weq/service';
import { dressupRouter } from '../src/main/ipc/routers/dressup';
const state = vi.hoisted(() => ({
  configId: 'source-a',
  services: {} as object,
  selected: '' as string | null,
  root: '',
  web: false,
  pickDirectory: vi.fn<() => Promise<string | null>>(),
  fetchMedia: vi.fn<(url: string) => Promise<Response>>(),
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
    isPackaged: () => false,
    exportRoot: state.web ? state.root : undefined,
    registerDownload: () => ({ url: '/download' }),
    pickSaveTarget: async (input: unknown) => (state.selected ? state.pick(input) : null),
    pickDirectory: state.pickDirectory,
    fetchMedia: state.fetchMedia,
  }),
  requireDevelopmentDressTools: vi.fn(),
}));
let manager: ExportTaskManager;
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  fontId: 11,
  kind: 'font' as const,
};
beforeEach(() => {
  state.root = realpathSync(mkdtempSync(join(tmpdir(), 'weq-dress-save-')));
  state.configId = 'source-a';
  state.web = false;
  state.selected = join(state.root, 'chosen.ttf');
  state.pick.mockClear();
  state.pickDirectory.mockReset().mockResolvedValue(state.root);
  state.fetchMedia.mockReset();
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
  expect(state.pick).toHaveBeenCalledWith({
    defaultName: `真实产物.${extension}`,
    extension,
    locationKey: 'dressup:font',
    defaultDirectory: undefined,
  });
  await vi.waitFor(() => expect(manager.getTask(result.taskId)?.save?.status).toBe('saved'));
  expect(readFileSync(state.selected!, 'utf8')).toBe('fixture-resource');
});
it('取消公共选择器不创建任务，旧稍后保存参数直接拒绝', async () => {
  state.selected = null;
  const api = dressupRouter.createCaller({});
  expect(await api.saveMsgDecoration({ ...input, savePolicy: { mode: 'before' } })).toEqual({
    mode: 'cancelled',
  });
  expect(manager.listTasks()).toEqual([]);
  await expect(
    api.saveMsgDecoration({ ...input, savePolicy: { mode: 'after' } } as unknown as Parameters<
      typeof api.saveMsgDecoration
    >[0]),
  ).rejects.toThrow();
  expect(manager.listTasks()).toEqual([]);
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

const catalogInput = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  kind: 'font' as const,
  items: [{ itemId: 11, name: '字体甲' }],
};

it('个性装扮先选文件夹，选定后创建任务，再获取资源并按实际格式保存', async () => {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  state.pickDirectory.mockReturnValueOnce(promise);
  state.build.mockImplementationOnce(async () => {
    expect(manager.listTasks()).toHaveLength(1);
    return { fileName: 'WeQ-字体-11.ttf', bytes: Buffer.from('fixture-resource'), kind: 'font' };
  });
  const request = dressupRouter.createCaller({}).download(catalogInput);
  await vi.waitFor(() => expect(state.pickDirectory).toHaveBeenCalledOnce());
  expect(state.build).not.toHaveBeenCalled();
  expect(manager.listTasks()).toEqual([]);
  resolve(state.root);
  const taskId = (await request)!;
  const path = join(state.root, 'WeQ-字体-11.ttf');
  await vi.waitFor(() =>
    expect(manager.getTask(taskId)?.save).toMatchObject({ path, status: 'saved' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('fixture-resource');
});

it('装扮选择取消或更换账号来源时，任务与资源下载均未开始', async () => {
  const api = dressupRouter.createCaller({});
  state.pickDirectory.mockResolvedValueOnce(null);
  await expect(api.download(catalogInput)).resolves.toBeNull();
  state.pickDirectory.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return state.root;
  });
  await expect(api.download(catalogInput)).rejects.toThrow('数据源已切换');
  expect(state.build).not.toHaveBeenCalled();
  expect(manager.listTasks()).toEqual([]);
});

it('多选去重，成功项打包，失败项写入同一任务', async () => {
  state.build.mockRejectedValueOnce(new Error('资源不可用'));
  state.build.mockResolvedValueOnce({
    fileName: 'WeQ-字体-12.ttf',
    bytes: Buffer.from('第二款字体'),
    kind: 'font',
  });
  const taskId = (await dressupRouter.createCaller({}).download({
    ...catalogInput,
    items: [...catalogInput.items, ...catalogInput.items, { itemId: 12, name: '字体乙' }],
  }))!;
  await vi.waitFor(() => expect(manager.getTask(taskId)?.save?.status).toBe('saved'));
  const task = manager.getTask(taskId)!;
  expect(state.build).toHaveBeenCalledTimes(2);
  expect(task.resource).toMatchObject({ failed: 1, output: { extension: 'zip' } });
  expect(task.stages[0]?.failures).toEqual([
    expect.objectContaining({ fileName: '字体甲 (#11)', error: '资源不可用' }),
  ]);
  expect(readZipEntries(readFileSync(task.save!.path!))).toMatchObject([
    { name: 'WeQ-字体-12.ttf', data: Buffer.from('第二款字体') },
  ]);
});

it('通话背景在任务中识别媒体格式再保存，文件名采用实际视频后缀', async () => {
  const url = 'https://tianquan.gtimg.cn/fixture/background';
  state.fetchMedia.mockImplementation(
    async () => new Response('fixture-mp4', { headers: { 'content-type': 'video/mp4' } }),
  );
  state.pickDirectory.mockImplementationOnce(async () => {
    expect(state.fetchMedia).not.toHaveBeenCalled();
    return state.root;
  });
  const taskId = (await dressupRouter.createCaller({}).download({
    ...catalogInput,
    kind: 'callbg',
    items: [{ itemId: 22, name: '示例背景', mediaUrl: url }],
  }))!;
  const path = join(state.root, 'WeQ-通话背景-22 示例背景.mp4');
  await vi.waitFor(() =>
    expect(manager.getTask(taskId)?.save).toMatchObject({ path, status: 'saved' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('fixture-mp4');
});
