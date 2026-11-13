import { afterEach, expect, it, vi } from 'vitest';
import { stageAccountFile } from '../src/renderer/src/lib/accountFilePicker';
import { BROWSER_FILE_CHUNK_BYTES } from '../src/shared/browser_file_upload';

const api = vi.hoisted(() => ({
  start: vi.fn(async () => ({ id: 'upload' })),
  chunk: vi.fn(async ({ offset, base64 }: { offset: number; base64: string }) => ({
    offset: offset + atob(base64).length,
  })),
  finish: vi.fn(async () => ({ path: '/stage/file.bin', fileName: 'file.bin', size: 3 })),
  discard: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: { getState: () => ({ openedUin: '10001' }) },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      pickedFileStart: { mutate: api.start },
      pickedFileChunk: { mutate: api.chunk },
      pickedFileFinish: { mutate: api.finish },
      pickedFileDiscard: { mutate: api.discard },
    },
  },
}));
afterEach(() => vi.clearAllMocks());
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source' };
const file = (size: number) =>
  ({
    name: 'file.bin',
    size,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).buffer,
    }),
  }) as File;

it('中途取消后不上传下一块，不完成暂存，并清理句柄', async () => {
  const controller = new AbortController();
  api.chunk.mockImplementationOnce(async ({ offset, base64 }) => {
    controller.abort();
    return { offset: offset + atob(base64).length };
  });
  await expect(
    stageAccountFile(file(BROWSER_FILE_CHUNK_BYTES + 2), binding, controller.signal),
  ).rejects.toThrow();
  expect(api.chunk).toHaveBeenCalledTimes(1);
  expect(api.finish).not.toHaveBeenCalled();
  expect(api.discard).toHaveBeenCalledWith({ ...binding, uploadId: 'upload' });
});

it('开始前取消不创建暂存，正常传输仍保留完成回执', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(stageAccountFile(file(3), binding, controller.signal)).rejects.toThrow();
  expect(api.start).not.toHaveBeenCalled();
  expect(await stageAccountFile(file(3), binding)).toMatchObject({
    fileName: 'file.bin',
    uploadId: 'upload',
  });
});
