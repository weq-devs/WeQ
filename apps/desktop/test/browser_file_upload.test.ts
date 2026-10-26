import { expect, it, vi } from 'vitest';
import { withBrowserFile } from '../src/renderer/src/lib/browserFileUpload';
import { BROWSER_FILE_CHUNK_BYTES } from '../src/shared/browser_file_upload';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
function fixture() {
  const received: Buffer[] = [];
  const api = {
    browserFileStart: { mutate: vi.fn(async () => ({ id: 'upload' })) },
    browserFileChunk: {
      mutate: vi.fn(async (input: { offset: number; base64: string }) => {
        const bytes = Buffer.from(input.base64, 'base64');
        received.push(bytes);
        return { offset: input.offset + bytes.length };
      }),
    },
    browserFileDiscard: { mutate: vi.fn(async () => {}) },
  };
  return { api, received };
}
it('分段传输后才提交一次真实发送，保留尾段与原始字节', async () => {
  const { api, received } = fixture();
  const bytes = new Uint8Array(BROWSER_FILE_CHUNK_BYTES + 3).fill(123);
  const send = vi.fn(async () => 'accepted');
  expect(await withBrowserFile(api, binding, bytes, () => true, send)).toBe('accepted');
  expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
  expect(api.browserFileChunk.mutate).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith('upload');
  expect(api.browserFileDiscard.mutate).toHaveBeenCalledOnce();
  expect(api.browserFileDiscard.mutate).toHaveBeenCalledWith({ ...binding, uploadId: 'upload' });
});
it('分段途中切换会话，清理句柄且不提交发送', async () => {
  const { api } = fixture();
  let current = true;
  api.browserFileChunk.mutate.mockImplementationOnce(async () => {
    current = false;
    return { offset: 3 };
  });
  const send = vi.fn();
  await expect(
    withBrowserFile(api, binding, new Uint8Array([1, 2, 3]), () => current, send),
  ).rejects.toThrow('切换');
  expect(send).not.toHaveBeenCalled();
  expect(api.browserFileDiscard.mutate).toHaveBeenCalledOnce();
});
it('分段失败或真实发送结果未知均不自动重试，清理异常不覆盖原错误', async () => {
  const { api } = fixture();
  const send = vi.fn(async () => {
    throw new Error('发送结果未知');
  });
  api.browserFileDiscard.mutate.mockRejectedValueOnce(new Error('清理失败'));
  await expect(
    withBrowserFile(api, binding, new Uint8Array([1]), () => true, send),
  ).rejects.toThrow('发送结果未知');
  expect(send).toHaveBeenCalledOnce();
  const bad = fixture();
  bad.api.browserFileChunk.mutate.mockRejectedValueOnce(new Error('断线'));
  await expect(
    withBrowserFile(bad.api, binding, new Uint8Array([1]), () => true, send),
  ).rejects.toThrow('断线');
  expect(send).toHaveBeenCalledOnce();
});
it('回执偏移错误或空文件不进入发送', async () => {
  const { api } = fixture();
  const send = vi.fn();
  api.browserFileChunk.mutate.mockResolvedValueOnce({ offset: 0 });
  await expect(
    withBrowserFile(api, binding, new Uint8Array([1]), () => true, send),
  ).rejects.toThrow('进度');
  await expect(withBrowserFile(api, binding, new Uint8Array(), () => true, send)).rejects.toThrow(
    '非空',
  );
  expect(api.browserFileStart.mutate).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
