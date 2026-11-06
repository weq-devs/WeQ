import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileResponse } from '../src/main/file_response';

describe('内容寻址媒体响应', () => {
  it.each([
    [Buffer.from('89504e470d0a1a0a0000000000000000', 'hex'), 'image/png'],
    [Buffer.from('RIFF0000WAVEdata0000'), 'audio/wav'],
    [Buffer.from('0000ftypisom00000000'), 'video/mp4'],
  ] as const)('无扩展名的已归档资源按实际字节提供 MIME', async (bytes, type) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-cas-mime-'));
    try {
      const path = join(root, 'a'.repeat(64));
      await writeFile(path, bytes);
      const response = await fileResponse(path);
      expect(response.headers.get('content-type')).toBe(type);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
