import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '@weq/service';
import type { MsgService, AlbumMediaPage } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'fixture-source',
  services: {} as object,
  download: vi.fn(async (_url: string, _path: string, _opts?: { signal?: AbortSignal }) => ({
    ok: true as boolean,
    reason: '',
  })),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: state.uin } }, services: state.services }),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  clientKeyExpiryMs: () => Date.now() + 60000,
  downloadUrlToFile: state.download,
}));
const roots: string[] = [];
let manager: ExportTaskManager;
const fileUrl = vi.fn(async (_group: number, id: string) => `https://synthetic.invalid/${id}`);
const listRecursive = vi.fn(async () => []);
const albums = vi.fn(
  async (): Promise<Pick<AlbumMediaPage, 'mediaList' | 'nextAttachInfo'>> => ({
    mediaList: [],
    nextAttachInfo: '',
  }),
);
beforeEach(() => {
  albums.mockReset().mockResolvedValue({ mediaList: [], nextAttachInfo: '' });
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-router-'));
  roots.push(root);
  manager = new ExportTaskManager({} as MsgService, join(root, 'cache'));
  state.uin = '10001';
  state.configId = 'fixture-source';
  state.services = {
    accountConfig: {
      getRecord: () => ({
        configId: state.configId,
        qqOnline: true,
        qqPid: 1,
        clientKey: 'synthetic',
      }),
    },
    exportManager: manager,
    groupFile: { listRecursive },
    mediaUrl: { getGroupFileUrl: fileUrl },
    groupAlbumMedia: { getMediaList: albums },
  };
  state.download.mockImplementation(async (url, path, opts) => {
    opts?.signal?.throwIfAborted();
    if (url.endsWith('/missing')) return { ok: false, reason: '合成缺失' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic');
    return { ok: true, reason: '' };
  });
});
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture-source' };
it('群文件入口固定精确选择，在任务私有缓存下载并保留部分失败，不递归扩大范围', async () => {
  const files = [
    { fileId: 'one', fileName: 'export-report.json', path: ['folder'] },
    { fileId: 'missing', fileName: 'missing.txt', path: [] },
  ];
  const id = await accountRouter.createCaller({}).startGroupFileExport({
    ...binding,
    groupCode: '123',
    name: '合成群文件',
    files,
    savePolicy: { mode: 'after' },
  });
  files[0]!.fileName = 'changed.txt';
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const task = manager.getTask(id)!;
  expect(readFileSync(join(task.bundleDir!, 'files', 'folder', 'export-report.json'), 'utf8')).toBe(
    'synthetic',
  );
  expect(task.resource?.failed).toBe(1);
  expect(listRecursive).not.toHaveBeenCalled();
  expect(state.download).toHaveBeenCalledTimes(2);
  expect(state.download.mock.calls.every(([, path]) => path.includes('.partial'))).toBe(true);
});
it('相册入口接入后台任务；明确空文件集合不扩大到全群', async () => {
  const api = accountRouter.createCaller({});
  const id = await api.startGroupAlbumExport({
    ...binding,
    groupCode: '123',
    name: '合成相册',
    albums: [{ id: 'a', title: '同名' }],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  expect(albums).toHaveBeenCalledWith('123', 'a', '');
  const empty = await api.startGroupFileExport({
    ...binding,
    groupCode: '123',
    name: '合成空集合',
    files: [],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(empty)?.status).toBe('completed'));
  expect(manager.getTask(empty)?.total).toBe(0);
  expect(listRecursive).not.toHaveBeenCalled();
});
it('账号或同号来源变化时不建资源任务', async () => {
  const input = {
    ...binding,
    groupCode: '123',
    name: '合成文件',
    files: [],
    savePolicy: { mode: 'after' as const },
  };
  state.configId = 'another-source';
  await expect(accountRouter.createCaller({}).startGroupFileExport(input)).rejects.toThrow(
    '账号数据源已切换',
  );
  state.uin = '10002';
  await expect(accountRouter.createCaller({}).startGroupFileExport(input)).rejects.toThrow(
    '账号已切换',
  );
  expect(manager.listTasks()).toEqual([]);
});

it('同名相册各自保留目录，不因名称相同覆盖其他相册文件', async () => {
  albums.mockResolvedValue({
    mediaList: [
      {
        type: 1,
        image: {
          name: 'same.jpg',
          sloc: 's',
          lloc: 'l',
          photoUrls: [],
          defaultUrl: { url: 'https://synthetic.invalid/photo', width: 1, height: 1 },
          isGif: false,
          hasRaw: true,
        },
        video: null,
        uploader: 'synthetic',
        batchId: '1',
        uploadTime: '1',
      },
    ],
    nextAttachInfo: '',
  });
  const id = await accountRouter.createCaller({}).startGroupAlbumExport({
    ...binding,
    groupCode: '123',
    name: '合成同名相册',
    albums: [
      { id: 'a', title: '同名' },
      { id: 'b', title: '同名' },
    ],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const directory = join(manager.getTask(id)!.bundleDir!, 'files');
  expect(readdirSync(directory).sort()).toEqual(['同名', '同名-2']);
  for (const name of readdirSync(directory))
    expect(readFileSync(join(directory, name, 'same.jpg'), 'utf8')).toBe('synthetic');
});

it('取消并发下载等待所有在途写入结束后才清理任务暂存区', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.download.mockImplementation(async (url, _path, opts) => {
    await new Promise<void>((resolve) =>
      opts?.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    if (url.endsWith('/slow')) await gate;
    return { ok: false, reason: 'aborted' };
  });
  const id = await accountRouter.createCaller({}).startGroupFileExport({
    ...binding,
    groupCode: '123',
    name: '合成并发取消',
    files: [
      { fileId: 'fast', fileName: 'fast.bin' },
      { fileId: 'slow', fileName: 'slow.bin' },
    ],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(2));
  manager.cancelTask(id);
  const cache = join(roots[0]!, 'cache');
  expect(readdirSync(cache).some((name) => name.endsWith('.partial'))).toBe(true);
  release();
  await vi.waitFor(() =>
    expect(readdirSync(cache).some((name) => name.endsWith('.partial'))).toBe(false),
  );
  expect(manager.getTask(id)?.bundleDir).toBeUndefined();
});
