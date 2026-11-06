// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { BROWSER_FILE_CHUNK_BYTES } from '../src/shared/browser_file_upload';

const f = vi.hoisted(() => ({
  uin: '10001',
  config: vi.fn(),
  start: vi.fn(),
  chunk: vi.fn(),
  finish: vi.fn(),
  discard: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: { getState: () => ({ openedUin: f.uin }) },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getAccountConfig: { query: f.config },
      pickedFileStart: { mutate: f.start },
      pickedFileChunk: { mutate: f.chunk },
      pickedFileFinish: { mutate: f.finish },
      pickedFileDiscard: { mutate: f.discard },
    },
  },
}));
import { stageAccountFile } from '../src/renderer/src/lib/accountFilePicker';

beforeEach(() => {
  vi.resetAllMocks();
  f.uin = '10001';
  f.config.mockResolvedValue({ uin: f.uin, configId: 'fixture' });
  f.start.mockResolvedValue({ id: 'upload' });
  f.chunk.mockImplementation(async ({ offset, base64 }: { offset: number; base64: string }) => ({
    offset: offset + Buffer.from(base64, 'base64').length,
  }));
  f.finish.mockResolvedValue({ path: '/fixture/file.zip', fileName: 'file.zip', size: 3 });
  f.discard.mockResolvedValue(undefined);
});
it('按片读取设备文件，完成后保留草稿附件，不误删供后续使用的路径', async () => {
  const file = new File([new Uint8Array(BROWSER_FILE_CHUNK_BYTES + 3)], 'file.zip');
  const whole = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('不应读取整个文件'));
  expect((await stageAccountFile(file)).fileName).toBe('file.zip');
  expect(f.chunk).toHaveBeenCalledTimes(2);
  expect(whole).not.toHaveBeenCalled();
  expect(f.finish).toHaveBeenCalledOnce();
  expect(f.discard).not.toHaveBeenCalled();
});
it('切号停止后续分片和发布；仅回收本轮暂存', async () => {
  f.chunk.mockImplementationOnce(async () => {
    f.uin = '20002';
    return { offset: 1 };
  });
  await expect(stageAccountFile(new File([new Uint8Array([1])], 'file.txt'))).rejects.toThrow(
    '切换',
  );
  expect(f.finish).not.toHaveBeenCalled();
  expect(f.discard).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'fixture',
    uploadId: 'upload',
  });
});
it('错误进度不发布，清理失败不掩盖原错误', async () => {
  f.chunk.mockResolvedValueOnce({ offset: 0 });
  f.discard.mockRejectedValueOnce(new Error('cleanup'));
  await expect(stageAccountFile(new File(['x'], 'file.txt'))).rejects.toThrow('进度');
  expect(f.finish).not.toHaveBeenCalled();
});
