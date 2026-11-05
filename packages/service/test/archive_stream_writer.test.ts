import { describe, expect, it, vi } from 'vitest';
import { bufferedFileWriter } from '../src/account/export/stream_utils';

describe('归档有界缓冲写入', () => {
  it('提交点前显式刷出所有文本，达到上限自动刷出且顺序不变', async () => {
    const writeFile = vi.fn(async (_text: string) => {});
    const writer = bufferedFileWriter({ writeFile }, 4);
    await writer.write('a');
    await writer.write('b');
    expect(writeFile).not.toHaveBeenCalled();
    await writer.flush();
    await writer.write('cdef');
    await writer.write('g');
    await writer.flush();
    await writer.flush();
    expect(writeFile.mock.calls.map((call) => call[0])).toEqual(['ab', 'cdef', 'g']);
  });
  it('落盘失败向调用方传播，不能作为成功提交', async () => {
    const writer = bufferedFileWriter(
      {
        writeFile: async () => {
          throw new Error('disk-full');
        },
      },
      1,
    );
    await expect(writer.write('x')).rejects.toThrow('disk-full');
  });
});
