// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fetchOfficialArchive,
  officialArchive,
  verifyOfficialArchive,
} from '../src/main/update/official_archive';
const bytes = Buffer.from('synthetic official AppImage');
const name = 'weQ-1.1.0-linux-x86_64.AppImage';
const digest = createHash('sha256').update(bytes).digest('hex');
const release = {
  tag_name: 'v1.1.0',
  draft: false,
  prerelease: false,
  assets: [{ name, state: 'uploaded', digest: `sha256:${digest}`, size: bytes.length }],
};
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('合法镜像包以官方大小和摘要验证，同版本替换包不能靠镜像自报 hash 通过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-official-update-'));
  roots.push(root);
  const path = join(root, name);
  const expected = officialArchive(release, '1.1.0', name);
  writeFileSync(path, bytes);
  await expect(verifyOfficialArchive(path, expected)).resolves.toBeUndefined();
  writeFileSync(path, Buffer.alloc(bytes.length, 42));
  await expect(verifyOfficialArchive(path, expected)).rejects.toThrow('SHA-256');
  writeFileSync(path, 'short');
  await expect(verifyOfficialArchive(path, expected)).rejects.toThrow('大小');
  symlinkSync(path, join(root, 'link'));
  await expect(verifyOfficialArchive(join(root, 'link'), expected)).rejects.toThrow('大小');
});
it('拒绝缺摘要、重复资产、错误版本、草稿和未开启的测试版', () => {
  expect(() =>
    officialArchive(
      { ...release, assets: [{ ...release.assets[0], digest: null }] },
      '1.1.0',
      name,
    ),
  ).toThrow('SHA-256');
  expect(() =>
    officialArchive({ ...release, assets: [...release.assets, ...release.assets] }, '1.1.0', name),
  ).toThrow('SHA-256');
  expect(() => officialArchive(release, '1.2.0', name)).toThrow('版本');
  expect(() => officialArchive({ ...release, draft: true }, '1.1.0', name)).toThrow();
  expect(() => officialArchive({ ...release, prerelease: true }, '1.1.0', name)).toThrow('测试版');
  expect(officialArchive({ ...release, prerelease: true }, '1.1.0', name, true)).toMatchObject({
    sha256: digest,
  });
});
it('信任信息只从固定官方 HTTPS Release API 获取，不接受重定向', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(release)));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchOfficialArchive('1.1.0', name)).resolves.toEqual({
    sha256: digest,
    size: bytes.length,
  });
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/weq-devs/WeQ/releases/tags/v1.1.0',
    expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
  );
});
