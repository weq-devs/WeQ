import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '@weq/service';
import type {
  MsgService,
  AlbumMediaPage,
  DbDecryptOptions,
  DbDecryptResult,
  AccountDbFile,
} from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';
import { QZONE_ALBUM_PAGE_SIZE } from '../src/shared/qzone_album_export';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'fixture-source',
  failedDatabasePath: '',
  nativePath: '',
  nativeDirectory: '',
  serverRoot: undefined as string | undefined,
  afterPick: null as (() => void) | null,
  register: vi.fn((_path: string, _name: string, _kind: 'file' | 'directory') => ({
    url: '/download/synthetic',
  })),
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
  getHost: () => ({
    exportRoot: state.serverRoot,
    registerDownload: state.register,
    pickSaveTarget: async () => {
      state.afterPick?.();
      return state.nativePath ? { path: state.nativePath, downloadId: null } : null;
    },
    pickDirectory: async () => {
      state.afterPick?.();
      return state.nativeDirectory || null;
    },
  }),
}));
const roots: string[] = [];
const artifacts = new Map<string, string>();
let manager: ExportTaskManager;
let databaseFiles: AccountDbFile[] = [];
const decrypt = vi.fn(async (opts: DbDecryptOptions): Promise<DbDecryptResult[]> => {
  opts.signal?.throwIfAborted();
  return opts.items.map((item, index) => {
    const outPath = join(opts.outputDir, item.name!);
    writeFileSync(outPath, 'synthetic-plain-database');
    opts.onProgress?.(index + 1, opts.items.length);
    return {
      name: item.name!,
      dbPath: item.dbPath,
      outPath,
      ok: item.dbPath !== state.failedDatabasePath,
      ...(item.dbPath === state.failedDatabasePath ? { error: '合成解密失败' } : {}),
    };
  });
});
const fileUrl = vi.fn(async (_group: number, id: string) => `https://synthetic.invalid/${id}`);
const listRecursive = vi.fn(async () => []);
const albums = vi.fn(
  async (): Promise<Pick<AlbumMediaPage, 'mediaList' | 'nextAttachInfo'>> => ({
    mediaList: [],
    nextAttachInfo: '',
  }),
);
const qzoneVideo = vi.fn(
  async (_host: string, _topic: string, _key: string): Promise<string | null> =>
    'https://synthetic.invalid/movie.mp4',
);
const qzonePhotos = vi.fn(
  async (
    _host: string,
    _topic: string,
    _start: number,
    _size: number,
  ): Promise<{
    photos: Array<{
      id: string;
      name: string;
      url: string;
      thumbUrl: string;
      isVideo: boolean;
      picKey: string;
    }>;
    totalInAlbum: number;
  }> => ({ photos: [], totalInAlbum: 0 }),
);
beforeEach(() => {
  qzoneVideo.mockReset().mockResolvedValue('https://synthetic.invalid/movie.mp4');
  qzonePhotos.mockReset().mockResolvedValue({ photos: [], totalInAlbum: 0 });
  artifacts.clear();
  albums.mockReset().mockResolvedValue({ mediaList: [], nextAttachInfo: '' });
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-router-'));
  roots.push(root);
  manager = new ExportTaskManager({} as MsgService, join(root, 'cache'));
  state.uin = '10001';
  state.configId = 'fixture-source';
  const reportPath = join(root, 'report.html');
  writeFileSync(reportPath, '<h1>synthetic-report</h1>');
  artifacts.set('report.html', reportPath);
  state.failedDatabasePath = '';
  state.nativePath = '';
  state.nativeDirectory = '';
  state.serverRoot = undefined;
  state.afterPick = null;
  databaseFiles = ['msg.db', 'login.db'].map((name) => {
    const path = join(root, name);
    writeFileSync(path, 'synthetic-encrypted');
    return { name, path, bytes: 19, kind: 'account' };
  });
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
    webQuery: { getQzoneAlbumVideoUrl: qzoneVideo, getQzoneAlbumPhotos: qzonePhotos },
    dbDecrypt: {
      listDatabases: async () => databaseFiles,
      decryptDatabases: decrypt,
      isQqLoggedIn: () => true,
    },
    assistant: {
      artifactInfo: (id: string) => {
        const path = artifacts.get(id);
        if (!path) throw new Error('报告文件不存在');
        return { path, kind: 'html', mime: 'text/html' };
      },
    },
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
it('助手报告只复制既有句柄产物，不调用模型；回执只返回保存所需字段', async () => {
  const id = await accountRouter.createCaller({}).startAssistantArtifactSave({
    ...binding,
    id: 'report.html',
    name: '合成报告.html',
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const task = manager.getTask(id)!;
  expect(task.resource?.kind).toBe('assistant-artifact');
  expect(readFileSync(task.filePath!, 'utf8')).toBe('<h1>synthetic-report</h1>');
  const receipt = await accountRouter
    .createCaller({})
    .getExportOutputReceipt({ ...binding, taskId: id });
  expect(receipt?.output).toEqual({ kind: 'file', name: '合成报告', extension: 'html' });
  expect(receipt).not.toHaveProperty('generated');
  expect(receipt).not.toHaveProperty('filePath');
  const target = join(roots[0]!, 'saved.html');
  writeFileSync(target, 'personal');
  const saved = await accountRouter
    .createCaller({})
    .saveExportTaskOutput({ ...binding, taskId: id, filePath: target, uniqueFileName: true });
  expect(readFileSync(saved!, 'utf8')).toBe('<h1>synthetic-report</h1>');
  expect(readFileSync(target, 'utf8')).toBe('personal');
});
it('助手报告句柄、回执和保存均受数据源绑定约束', async () => {
  const api = accountRouter.createCaller({});
  await expect(
    api.startAssistantArtifactSave({
      ...binding,
      id: 'missing',
      name: 'missing.html',
      savePolicy: { mode: 'after' },
    }),
  ).rejects.toThrow('报告文件不存在');
  state.configId = 'other-source';
  await expect(
    api.startAssistantArtifactSave({
      ...binding,
      id: 'report.html',
      name: '报告.html',
      savePolicy: { mode: 'after' },
    }),
  ).rejects.toThrow('账号数据源已切换');
  await expect(api.getExportOutputReceipt({ ...binding, taskId: 'missing' })).rejects.toThrow(
    '账号数据源已切换',
  );
  expect(manager.listTasks()).toEqual([]);
});
it('Web 报告下载只注册当前来源的已生成文件，不创建任务或改默认位置', async () => {
  const api = accountRouter.createCaller({});
  expect(
    await api.assistantArtifactDownload({ ...binding, id: 'report.html', name: '合成报告.html' }),
  ).toEqual({ url: '/download/synthetic' });
  expect(state.register).toHaveBeenCalledWith(
    artifacts.get('report.html'),
    '合成报告.html',
    'file',
  );
  expect(manager.listTasks()).toEqual([]);
  state.configId = 'other-source';
  await expect(
    api.assistantArtifactDownload({ ...binding, id: 'report.html', name: '合成报告.html' }),
  ).rejects.toThrow('账号数据源已切换');
  await expect(api.exportTaskDownload({ ...binding, taskId: 'not-owned' })).rejects.toThrow(
    '账号数据源已切换',
  );
  expect(state.register).toHaveBeenCalledOnce();
});
it('旧报告另存与任务另存拒绝覆盖已有内容，并沿用统一单文件保存', async () => {
  const api = accountRouter.createCaller({});
  const target = join(roots[0]!, 'legacy.html');
  state.nativePath = target;
  writeFileSync(target, 'personal');
  await expect(
    api.saveAssistantArtifact({ ...binding, id: 'report.html', name: '报告.html' }),
  ).rejects.toThrow(/同名/);
  expect(readFileSync(target, 'utf8')).toBe('personal');
  const id = await api.startAssistantArtifactSave({
    ...binding,
    id: 'report.html',
    name: '合成报告.html',
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  await expect(api.saveAssistantExport({ ...binding, taskId: id })).rejects.toThrow(/同名/);
  state.nativePath = join(roots[0]!, 'legacy-task.html');
  expect(
    await api.saveExportFile({
      ...binding,
      sourcePath: manager.getTask(id)!.filePath!,
      defaultName: '自定名称.html',
      format: 'html',
    }),
  ).toBe(true);
  expect(readFileSync(state.nativePath, 'utf8')).toBe('<h1>synthetic-report</h1>');
  await expect(
    api.saveExportFile({
      ...binding,
      sourcePath: artifacts.get('report.html')!,
      defaultName: '任意文件.html',
      format: 'html',
    }),
  ).rejects.toThrow(/单文件导出结果/);
});
it('旧整包另存不合并同名目录，选择器取消或换来源不复制', async () => {
  const api = accountRouter.createCaller({});
  const id = await manager.startResourceExport({
    kind: 'group-files',
    name: '同名目录',
    savePolicy: { mode: 'after' },
    run: async ({ directory }) => {
      writeFileSync(join(directory, 'file.bin'), 'synthetic');
      return { total: 1, ok: 1, failed: [] };
    },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  expect(await api.saveExportBundle({ ...binding, taskId: id })).toBe(false);
  state.nativeDirectory = join(roots[0]!, 'chosen');
  mkdirSync(state.nativeDirectory);
  mkdirSync(join(state.nativeDirectory, '同名目录'));
  writeFileSync(join(state.nativeDirectory, '同名目录', 'personal.txt'), 'preserve');
  expect(await api.saveExportBundle({ ...binding, taskId: id })).toBe(true);
  expect(readFileSync(join(state.nativeDirectory, '同名目录', 'personal.txt'), 'utf8')).toBe(
    'preserve',
  );
  state.nativePath = join(roots[0]!, 'not-created.html');
  state.afterPick = () => {
    state.configId = 'another-source';
  };
  await expect(
    api.saveAssistantArtifact({ ...binding, id: 'report.html', name: '报告.html' }),
  ).rejects.toThrow(/数据源已切换/);
  expect(readdirSync(roots[0]!)).not.toContain('not-created.html');
  state.configId = 'fixture-source';
  const before = readdirSync(state.nativeDirectory).sort();
  await expect(api.saveAssistantExport({ ...binding, taskId: id })).rejects.toThrow(/数据源已切换/);
  expect(readdirSync(state.nativeDirectory).sort()).toEqual(before);
});
it('单库后台解密使用真实 db 产物，按明确文件名保存且不改源库', async () => {
  const target = join(roots[0]!, 'chosen.db');
  const id = await accountRouter.createCaller({}).startDatabasePlainExport({
    ...binding,
    dbPaths: [databaseFiles[0]!.path],
    mode: 'safe',
    savePolicy: { mode: 'before', filePath: target },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.save?.status).toBe('saved'));
  expect(manager.getTask(id)?.bundleDir).toBeUndefined();
  expect(manager.getTask(id)?.resource?.output?.extension).toBe('db');
  expect(readFileSync(target, 'utf8')).toBe('synthetic-plain-database');
  expect(readFileSync(databaseFiles[0]!.path, 'utf8')).toBe('synthetic-encrypted');
  expect(decrypt.mock.calls[0]![0]).toMatchObject({
    mode: 'safe',
    signal: expect.any(AbortSignal),
  });
});
it('多库保留成功产物和失败清单，但不把失败解密的残留文件发布', async () => {
  state.failedDatabasePath = databaseFiles[1]!.path;
  const api = accountRouter.createCaller({});
  const id = await api.startDatabasePlainExport({
    ...binding,
    dbPaths: databaseFiles.map((db) => db.path),
    mode: 'fast',
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const task = manager.getTask(id)!;
  expect(readdirSync(join(task.bundleDir!, 'files'))).toEqual(['msg.db']);
  expect(task.resource?.failed).toBe(1);
  expect(readFileSync(join(task.bundleDir!, 'resource-results.json'), 'utf8')).toContain(
    '合成解密失败',
  );
  const failed = await api.startDatabasePlainExport({
    ...binding,
    dbPaths: [state.failedDatabasePath],
    mode: 'safe',
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(failed)?.status).toBe('failed'));
  expect(manager.getTask(failed)?.filePath).toBeUndefined();
  expect(manager.getTask(failed)?.error).toContain('合成解密失败');
});
it('明文任务与在线检查拒绝同号配置切换，范围外库不建任务', async () => {
  const api = accountRouter.createCaller({});
  await expect(
    api.startDatabasePlainExport({
      ...binding,
      dbPaths: ['/synthetic/not-owned.db'],
      mode: 'safe',
    }),
  ).rejects.toThrow('当前账号');
  state.configId = 'other-source';
  await expect(
    api.startDatabasePlainExport({ ...binding, dbPaths: [databaseFiles[0]!.path], mode: 'safe' }),
  ).rejects.toThrow('账号数据源已切换');
  await expect(api.isQqLoggedIn(binding)).rejects.toThrow('账号数据源已切换');
  expect(manager.listTasks()).toEqual([]);
  expect(decrypt).not.toHaveBeenCalled();
});
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

const selectedQzone = {
  ...binding,
  hostUin: '20002',
  topicId: 'album-a',
  name: '合成相册',
  items: [{ id: 'placeholder', name: 'photo.jpg', url: 'https://synthetic.invalid/photo.jpg' }],
};
it('空间相册单张照片按真实 jpg 单文件保存，不枚举相册或扩大选择', async () => {
  state.nativePath = join(roots[0]!, 'chosen.jpg');
  const id = await accountRouter
    .createCaller({})
    .startQzoneAlbumMediaExport({ ...selectedQzone, savePolicy: { mode: 'before' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('saved'));
  expect(manager.getTask(id!)?.resource?.output).toEqual({
    kind: 'file',
    name: 'photo',
    extension: 'jpg',
  });
  expect(readFileSync(state.nativePath, 'utf8')).toBe('synthetic');
  expect(qzonePhotos).not.toHaveBeenCalled();
  expect(qzoneVideo).not.toHaveBeenCalled();
  expect(state.download).toHaveBeenCalledTimes(1);
});
it.each([true, false])('单个视频按实际本体／封面选择后缀，本体可用=%s', async (available) => {
  qzoneVideo.mockResolvedValueOnce(available ? 'https://synthetic.invalid/movie.mp4' : null);
  const id = await accountRouter.createCaller({}).startQzoneAlbumMediaExport({
    ...selectedQzone,
    items: [{ ...selectedQzone.items[0]!, isVideo: true, picKey: 'video-key' }],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('completed'));
  expect(manager.getTask(id!)?.resource?.output?.extension).toBe(available ? 'mp4' : 'jpg');
  expect(qzoneVideo).toHaveBeenCalledWith('20002', 'album-a', 'video-key');
  expect(state.download.mock.calls[0]![0]).toBe(
    available ? 'https://synthetic.invalid/movie.mp4' : selectedQzone.items[0]!.url,
  );
});
it('多项空间媒体固定精确范围，重复占位 id 不合并，部分失败保留成功包', async () => {
  const items = [
    selectedQzone.items[0]!,
    { ...selectedQzone.items[0]!, url: 'https://synthetic.invalid/second.jpg' },
    { id: 'missing', name: 'missing.jpg', url: 'https://synthetic.invalid/missing' },
  ];
  const id = await accountRouter
    .createCaller({})
    .startQzoneAlbumMediaExport({ ...selectedQzone, items, savePolicy: { mode: 'after' } });
  items[0] = { ...items[0]!, name: 'changed.jpg' };
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('completed'));
  const task = manager.getTask(id!)!;
  expect(task.total).toBe(3);
  expect(task.resource?.failed).toBe(1);
  expect(task.filePath).toBeUndefined();
  expect(readdirSync(join(task.bundleDir!, 'files')).sort()).toEqual(['photo-2.jpg', 'photo.jpg']);
  expect(qzonePhotos).not.toHaveBeenCalled();
  expect(state.download).toHaveBeenCalledTimes(3);
});
it('空间媒体取消位置不建任务，选择期间来源变化不下载', async () => {
  const api = accountRouter.createCaller({});
  expect(
    await api.startQzoneAlbumMediaExport({ ...selectedQzone, savePolicy: { mode: 'before' } }),
  ).toBeNull();
  state.nativePath = join(roots[0]!, 'not-created.jpg');
  state.afterPick = () => {
    state.configId = 'other-source';
  };
  await expect(
    api.startQzoneAlbumMediaExport({ ...selectedQzone, savePolicy: { mode: 'before' } }),
  ).rejects.toThrow('数据源已切换');
  expect(manager.listTasks()).toEqual([]);
  expect(state.download).not.toHaveBeenCalled();
});
it('整本空间相册仅遍历已选相册，分页重复作为明确失败保留已下载文件', async () => {
  const photo = {
    id: 'placeholder',
    name: 'photo.jpg',
    url: 'https://synthetic.invalid/photo.jpg',
    thumbUrl: '',
    isVideo: false,
    picKey: 'key',
  };
  qzonePhotos.mockResolvedValue({ photos: [photo], totalInAlbum: 2 });
  const id = await accountRouter.createCaller({}).startQzoneAlbumsExport({
    ...binding,
    hostUin: '20002',
    name: '合成相册',
    albums: [{ id: 'selected', title: '选中' }],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('completed'));
  expect(qzonePhotos.mock.calls).toEqual([
    ['20002', 'selected', 0, QZONE_ALBUM_PAGE_SIZE],
    ['20002', 'selected', 1, QZONE_ALBUM_PAGE_SIZE],
  ]);
  const task = manager.getTask(id!)!;
  expect(task.resource?.failed).toBe(1);
  expect(readFileSync(join(task.bundleDir!, 'resource-results.json'), 'utf8')).toContain(
    '分页重复',
  );
  expect(state.download).toHaveBeenCalledTimes(1);
});
it('整本空间相册取页后来源变化，不继续旧相册的下载', async () => {
  qzonePhotos.mockImplementationOnce(async () => {
    state.configId = 'other-source';
    return { photos: [], totalInAlbum: 0 };
  });
  const id = await accountRouter.createCaller({}).startQzoneAlbumsExport({
    ...binding,
    hostUin: '20002',
    name: '合成相册',
    albums: [{ id: 'selected' }],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('failed'));
  expect(manager.getTask(id!)?.bundleDir).toBeUndefined();
  expect(state.download).not.toHaveBeenCalled();
});
it('Web 空间单文件只保存到服务器根内，旧入口同样拒绝越界路径', async () => {
  state.serverRoot = join(roots[0]!, 'server');
  mkdirSync(state.serverRoot);
  const api = accountRouter.createCaller({});
  const id = await api.startQzoneAlbumMediaExport({
    ...selectedQzone,
    savePolicy: { mode: 'before', directory: 'selected' },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('saved'));
  expect(manager.getTask(id!)?.save?.path).toBe(
    join(realpathSync(state.serverRoot), 'selected', 'photo.jpg'),
  );
  await expect(
    api.exportQzoneAlbumMedia({ ...selectedQzone, outputDir: '/outside-server-root' }),
  ).rejects.toThrow();
  expect(state.download).toHaveBeenCalledTimes(1);
});
it('空间媒体任务取消会中止所有在途下载，半成品不发布', async () => {
  state.download.mockImplementation(async (_url, _path, opts) => {
    await new Promise<void>((resolve) =>
      opts?.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { ok: false, reason: 'aborted' };
  });
  const id = await accountRouter.createCaller({}).startQzoneAlbumMediaExport({
    ...selectedQzone,
    items: [
      selectedQzone.items[0]!,
      { ...selectedQzone.items[0]!, url: 'https://synthetic.invalid/second.jpg' },
    ],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(2));
  manager.cancelTask(id!);
  await vi.waitFor(() => expect(manager.getTask(id!)?.error).toContain('中断'));
  expect(manager.getTask(id!)?.bundleDir).toBeUndefined();
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
});
