import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readArchiveFile } from '../src/account/export/archive';
import { writeResourceDirectoryArchive } from '../src/account/export/archive_directory';

it('资源目录按来源身份关联多层父项，并保留本地缩略图与原文件的角色', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-directory-details-'));
  try {
    await mkdir(join(root, 'files', 'outer', 'inner'), { recursive: true });
    await writeFile(join(root, 'files', 'outer', 'inner', 'photo.jpg'), 'photo');
    await writeFile(join(root, 'thumbnail.jpg'), 'thumbnail');
    await writeResourceDirectoryArchive(
      root,
      'json',
      { profile: 'full', accountUin: '10001' },
      [],
      [
        { sourceId: 'outer', name: '外层', type: 'folder', path: 'files/outer' },
        {
          sourceId: 'inner',
          parentSourceId: 'outer',
          name: '内层',
          type: 'album',
          path: 'files/outer/inner',
        },
        {
          sourceId: 'photo',
          parentSourceId: 'inner',
          name: '图片',
          type: 'photo',
          path: 'files/outer/inner/photo.jpg',
          variants: [{ path: 'thumbnail.jpg', role: 'thumbnail' }],
        },
      ],
    );
    const { archive } = await readArchiveFile(join(root, 'resource-results.json'), 'json');
    const outer = archive.records.find((record) => record.data.sourceId === 'outer')!;
    const inner = archive.records.find((record) => record.data.sourceId === 'inner')!;
    const photo = archive.records.find((record) => record.data.sourceId === 'photo')!;
    expect(inner.data.parentId).toBe(outer.id);
    expect(photo.data.parentId).toBe(inner.id);
    expect(photo.data.resourceIds).toHaveLength(2);
    expect(archive.resources.map((resource) => resource.role)).toContain('thumbnail');
    expect(archive.resources.every((resource) => resource.status === 'saved')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('未下载原文件也保留已有版本和缺失回执，不把资源伪装成目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-directory-variants-'));
  try {
    await mkdir(join(root, 'files'));
    await writeFile(join(root, 'preview.jpg'), 'preview');
    await writeResourceDirectoryArchive(
      root,
      'jsonl',
      { profile: 'full' },
      [],
      [
        {
          sourceId: 'photo',
          name: '图片',
          type: 'photo',
          status: 'missing',
          variants: [{ path: 'preview.jpg', role: 'preview' }],
        },
      ],
    );
    const { archive } = await readArchiveFile(join(root, 'resource-results.jsonl'), 'jsonl');
    expect(archive.records[0]!.data.type).toBe('photo');
    expect(archive.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'missing' }),
        expect.objectContaining({ status: 'saved', role: 'preview' }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
