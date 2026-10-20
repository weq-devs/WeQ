import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MediaElement, type MsgService } from '@weq/service';
import { makeSolidPng } from '@weq/protocol';
import { mediaSaveRouter } from '../src/main/ipc/routers/media_save';
const state = vi.hoisted(() => ({
  configId: 'source-a',
  services: {} as object,
  picked: null as string | null,
  afterPick: null as (() => void) | null,
  local: null as { fileName: string; localPath: string } | null,
  response: (): Response => new Response('fixture', { headers: { 'content-type': 'text/plain' } }),
  media: vi.fn(async (_request: Request): Promise<Response> => state.response()),
  asset: vi.fn(async (_request: Request): Promise<Response> => state.response()),
  fetch: vi.fn(
    async (_url: string, _opts?: { signal?: AbortSignal }): Promise<Response> => state.response(),
  ),
  fileInfo: vi.fn(async (_id: bigint) => state.local),
  find: vi.fn(
    async (
      _id: string,
      _kind: string,
      _token: string,
      _sub?: string,
      _scene?: string,
    ): Promise<{ element: MediaElement; conv: 'group' | 'c2c' | null } | null> => null,
  ),
  groupUrl: vi.fn(
    async (_group: number, _id: string, _bus: number, _name: string) =>
      'https://synthetic.invalid/group-file',
  ),
  fileUrl: vi.fn(
    async (_scene: string, _group: number, _element: MediaElement, _name: string) =>
      'https://synthetic.invalid/chat-file',
  ),
  unknownUrl: vi.fn(
    async (_group: number, _element: MediaElement, _name: string) =>
      'https://synthetic.invalid/forward-file',
  ),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
vi.mock('../src/main/media_protocol', () => ({
  handleMediaRequest: state.media,
  findMediaElement: state.find,
}));
vi.mock('../src/main/resource_protocol', () => ({ handleResourceRequest: state.asset }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({
    fetchMedia: state.fetch,
    pickSaveTarget: async () => {
      state.afterPick?.();
      return state.picked ? { path: state.picked, downloadId: null } : null;
    },
    pickDirectory: async () => null,
  }),
}));
let root: string, manager: ExportTaskManager;
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const png = makeSolidPng(2, 2, [30, 120, 90]);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-media-save-'));
  state.configId = 'source-a';
  state.picked = null;
  state.afterPick = null;
  state.local = null;
  state.response = () =>
    new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  state.media.mockClear();
  state.asset.mockClear();
  state.fetch.mockClear();
  state.fileInfo.mockClear();
  state.groupUrl.mockClear();
  state.fileUrl.mockClear();
  state.unknownUrl.mockClear();
  state.find.mockReset().mockResolvedValue(null);
  manager = new ExportTaskManager({} as MsgService, join(root, 'tasks'));
  state.services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    exportManager: manager,
    fileAssistant: { getFileInfoByMsgId: state.fileInfo },
    mediaUrl: {
      getGroupFileUrl: state.groupUrl,
      resolveFileUrl: state.fileUrl,
      resolveFileUrlUnknownScene: state.unknownUrl,
    },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const api = () => mediaSaveRouter.createCaller({});
const image = {
  kind: 'url' as const,
  url: 'weq-media://pic?t=1&name=original.jpg',
  name: '合成图片.jpg',
};
async function completed(id: string | null) {
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('completed'));
  return manager.getTask(id!)!;
}
it('图片复用原协议，按真实 PNG 类型保存，不把所有图片当 JPEG', async () => {
  state.response = () =>
    new Response(new Uint8Array(png), { headers: { 'content-type': 'image/jpeg' } });
  const id = await api().save({ ...binding, source: image, savePolicy: { mode: 'after' } });
  const task = await completed(id);
  expect(task.resource?.output).toEqual({ kind: 'file', name: '合成图片', extension: 'png' });
  expect(readFileSync(task.filePath!)).toEqual(Buffer.from(png));
  expect(state.fetch).not.toHaveBeenCalled();
});
it('语音沿用播放协议返回的 WAV，不给解码后的字节套 AMR 后缀', async () => {
  state.response = () =>
    new Response(new Uint8Array(80).fill(1), { headers: { 'content-type': 'audio/wav' } });
  const task = await completed(
    await api().save({
      ...binding,
      source: { kind: 'url', url: '/_media/ptt?name=voice.amr', name: 'voice.amr' },
      savePolicy: { mode: 'after' },
    }),
  );
  expect(task.resource?.output?.extension).toBe('wav');
  expect(state.media.mock.calls[0]![0].url).toBe('weq-media://ptt?name=voice.amr');
});
it('视频按流复制，元数据探测不读完整视频，不调用 arrayBuffer', async () => {
  const pulls: number[] = [],
    cancelled: boolean[] = [];
  const chunks = 32,
    bytes = 64 * 1024;
  state.response = () => {
    const index = pulls.length;
    pulls.push(0);
    cancelled.push(false);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls[index]! >= chunks) {
            controller.close();
            return;
          }
          pulls[index] = pulls[index]! + 1;
          controller.enqueue(new Uint8Array(bytes));
        },
        cancel() {
          cancelled[index] = true;
        },
      }),
      { headers: { 'content-type': 'video/mp4' } },
    );
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('不得整段缓冲视频'));
    return response;
  };
  const task = await completed(
    await api().save({
      ...binding,
      source: { kind: 'url', url: 'weq-media://video?t=1&name=video.mp4' },
      savePolicy: { mode: 'after' },
    }),
  );
  expect(cancelled[0]).toBe(true);
  expect(pulls[0]).toBeLessThan(chunks);
  expect(statSync(task.filePath!).size).toBe(chunks * bytes);
});
it('群文件取消位置不换链或建任务，实际下载固定 fileId 与 busId', async () => {
  const source = {
    kind: 'group-file' as const,
    groupCode: '123',
    fileId: 'selected-id',
    fileName: 'report.txt',
    busId: 7,
  };
  expect(await api().save({ ...binding, source, savePolicy: { mode: 'before' } })).toBeNull();
  expect(manager.listTasks()).toEqual([]);
  expect(state.groupUrl).not.toHaveBeenCalled();
  state.response = () => new Response('raw-file', { headers: { 'content-type': 'text/plain' } });
  const task = await completed(
    await api().save({ ...binding, source, savePolicy: { mode: 'after' } }),
  );
  expect(state.groupUrl).toHaveBeenCalledWith(123, 'selected-id', 7, 'report.txt');
  expect(readFileSync(task.filePath!, 'utf8')).toBe('raw-file');
});
it('本地文件只复制既有缓存，保留无后缀文件和原件，不要求在线换链', async () => {
  const sourcePath = join(root, 'README');
  writeFileSync(sourcePath, 'personal-cache');
  state.local = { fileName: 'README', localPath: `::NTOSFull::${sourcePath}` };
  const task = await completed(
    await api().save({
      ...binding,
      source: { kind: 'chat-file', msgId: '42', name: 'README' },
      savePolicy: { mode: 'after' },
    }),
  );
  expect(task.resource?.output).toEqual({ kind: 'file', name: 'README', extension: '' });
  expect(readFileSync(task.filePath!, 'utf8')).toBe('personal-cache');
  expect(readFileSync(sourcePath, 'utf8')).toBe('personal-cache');
  expect(state.fileUrl).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
});
it('转发文件沿用携带消息／子消息与未知场景换链，不误用外层消息', async () => {
  const element = { kind: 'file', fileToken: 'token-a', fileName: 'report.txt' };
  state.find.mockResolvedValue({ element, conv: null });
  state.response = () => new Response('forward-file');
  const task = await completed(
    await api().save({
      ...binding,
      source: {
        kind: 'chat-file',
        msgId: '41',
        fwdMsgId: '42',
        fwdKind: 'group',
        token: 'token-a',
        conv: '123',
        name: 'report.txt',
      },
      savePolicy: { mode: 'after' },
    }),
  );
  expect(state.fileInfo).toHaveBeenCalledWith(42n);
  expect(state.find).toHaveBeenCalledWith('41', 'file', 'token-a', '42', 'group');
  expect(state.unknownUrl).toHaveBeenCalledWith(123, element, 'report.txt');
  expect(state.fileUrl).not.toHaveBeenCalled();
  expect(readFileSync(task.filePath!, 'utf8')).toBe('forward-file');
});
it('找不到所选 token 时不回退成另一个文件，也不因同名本地记录绕过定位', async () => {
  const path = join(root, 'report.txt');
  writeFileSync(path, 'personal');
  state.local = { fileName: 'report.txt', localPath: path };
  state.find.mockResolvedValue({
    element: { kind: 'file', fileToken: 'different', fileName: 'report.txt' },
    conv: 'group',
  });
  await expect(
    api().save({
      ...binding,
      source: { kind: 'chat-file', msgId: '41', token: 'wanted', name: 'report.txt' },
      savePolicy: { mode: 'after' },
    }),
  ).rejects.toThrow('未找到所选文件');
  expect(manager.listTasks()).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe('personal');
});
it('选择器取消及来源变化不启动保存，已有文件不覆盖', async () => {
  expect(
    await api().save({ ...binding, source: image, savePolicy: { mode: 'before' } }),
  ).toBeNull();
  state.picked = join(root, 'existing.png');
  writeFileSync(state.picked, 'personal');
  const id = await api().save({ ...binding, source: image, savePolicy: { mode: 'before' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('failed'));
  expect(readFileSync(state.picked, 'utf8')).toBe('personal');
  expect(manager.getTask(id!)?.status).toBe('completed');
  state.afterPick = () => {
    state.configId = 'source-b';
  };
  await expect(
    api().save({ ...binding, source: image, savePolicy: { mode: 'before' } }),
  ).rejects.toThrow('数据源已切换');
});
it('探测后资源类型变化，不把 GIF 当作原先选择的 PNG 发布', async () => {
  let calls = 0;
  state.response = () =>
    ++calls === 1
      ? new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
      : new Response(Buffer.from('GIF89a\x01\0\x01\0synthetic'), {
          headers: { 'content-type': 'image/gif' },
        });
  const id = await api().save({ ...binding, source: image, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('failed'));
  expect(manager.getTask(id!)?.error).toContain('媒体类型');
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
});
it.each([404, 206])('不可用或部分资源 HTTP %s 不建有效任务', async (status) => {
  state.response = () => new Response('partial-or-missing', { status });
  await expect(
    api().save({ ...binding, source: image, savePolicy: { mode: 'after' } }),
  ).rejects.toThrow('媒体不可用');
  expect(manager.listTasks()).toEqual([]);
});
it('已完成媒体不被停止操作改成取消，完整结果保持可保存', async () => {
  const task = await completed(
    await api().save({ ...binding, source: image, savePolicy: { mode: 'after' } }),
  );
  expect(await api().cancel({ ...binding, taskId: task.id })).toBe(false);
  expect(manager.cancelTask(task.id)).toBe(false);
  expect(task.status).toBe('completed');
  expect(readFileSync(task.filePath!)).toEqual(Buffer.from(png));
});
