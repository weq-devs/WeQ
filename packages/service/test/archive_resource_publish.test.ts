import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '../src/account/export/archive';
import { publishArchiveResourceFile } from '../src/account/export/archive_resource';

const state = vi.hoisted(() => ({ unsupported: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (source: string, target: string) => {
      if (state.unsupported) throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
      return actual.link(source, target);
    },
  };
});
afterEach(() => {
  state.unsupported = false;
});
it.each([false, true])(
  '资源发布在不支持链接的磁盘上也校验字节并保留已有同名原件：%s',
  async (unsupported) => {
    state.unsupported = unsupported;
    const root = await mkdtemp(join(tmpdir(), 'weq-resource-publish-'));
    try {
      const source = join(root, 'owned.tmp'),
        target = join(root, 'resource');
      const bytes = Buffer.from('synthetic-resource'),
        digest = { sha256: sha256(bytes), size: String(bytes.length) };
      await writeFile(source, bytes);
      await publishArchiveResourceFile(source, target, digest);
      expect(await readFile(target)).toEqual(bytes);
      await publishArchiveResourceFile(source, target, digest);
      const personal = join(root, 'personal');
      await writeFile(personal, 'preserve');
      await expect(publishArchiveResourceFile(source, personal, digest)).rejects.toThrow(
        '内容冲突',
      );
      expect(await readFile(personal, 'utf8')).toBe('preserve');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
