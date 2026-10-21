import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import { buildZip, readZipEntries } from '../src/common/zip';
import {
  createFavoriteEmojiBundle,
  readFavoriteEmojiBundle,
  planFavoriteEmojiImport,
  FAVORITE_EMOJI_MANIFEST,
  FAVORITE_EMOJI_MAX_ITEMS,
  FAVORITE_EMOJI_BUNDLE_VERSION,
  type FavoriteEmojiExportSource,
} from '../src/account/favorite_emoji_bundle';

const png = Buffer.from(makeSolidPng(2, 3, [10, 20, 30]));
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const source = (bytes = png, position = 1): FavoriteEmojiExportSource => ({
  emojiId: `10001_0_0_0_${md5(bytes).toUpperCase()}_0_0`,
  md5: md5(bytes),
  description: `合成备注 ${position}`,
  position,
});

interface ManifestFixture {
  version: number;
  entries: Array<Record<string, unknown>>;
}
function changeManifest(archive: Buffer, update: (value: ManifestFixture) => void): Buffer {
  return buildZip(
    readZipEntries(archive).map((entry) => {
      if (entry.name !== FAVORITE_EMOJI_MANIFEST) return entry;
      const manifest = JSON.parse(entry.data.toString('utf8')) as ManifestFixture;
      update(manifest);
      return { ...entry, data: Buffer.from(JSON.stringify(manifest)) };
    }),
  );
}

describe('收藏表情往返包', () => {
  it('按原始字节保留 PNG／GIF、备注与顺序，同图只存一次', async () => {
    const progress = vi.fn();
    const sources = [source(png, 3), source(gif, 1), source(png, 2)];
    const result = await createFavoriteEmojiBundle(
      sources,
      async (entry) => (entry.md5 === md5(gif) ? gif : png),
      { progress },
    );
    expect(result).toMatchObject({ total: 3, written: 3, uniqueImages: 2, failed: [] });
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const items = readFavoriteEmojiBundle(result.archive);
    expect(items.map((entry) => entry.position)).toEqual([3, 1, 2]);
    expect(items.map((entry) => entry.description)).toEqual(
      sources.map((entry) => entry.description),
    );
    expect(items.map((entry) => entry.image?.bytes)).toEqual([png, gif, png]);
    expect(items.map((entry) => entry.image?.extension)).toEqual(['.png', '.gif', '.png']);
    expect(items.map((entry) => entry.image && [entry.image.width, entry.image.height])).toEqual([
      [2, 3],
      [1, 1],
      [2, 3],
    ]);
    expect(
      readZipEntries(result.archive).filter((entry) => entry.name.startsWith('images/')),
    ).toHaveLength(2);
  });

  it('缺图、错误原图和格式失败逐项保留，不用缩略图伪装原图', async () => {
    const result = await createFavoriteEmojiBundle(
      [source(png, 1), source(png, 2), source(png, 3), source(gif, 4)],
      async (entry) =>
        entry.position === 1
          ? null
          : entry.position === 2
            ? gif
            : entry.position === 3
              ? Buffer.from('not an image')
              : gif,
    );
    expect(result).toMatchObject({ total: 4, written: 1, uniqueImages: 1 });
    expect(result.failed.map((entry) => entry.position)).toEqual([1, 2, 3]);
    const items = readFavoriteEmojiBundle(result.archive);
    expect(items.map((entry) => Boolean(entry.image))).toEqual([false, false, false, true]);
    expect(items[0]?.issue).toContain('原图');
    expect(items[1]?.issue).toContain('MD5');
    expect(items[2]?.issue).toContain('格式');
  });

  it('读图异常不把路径、签名 URL 或外部错误写入分享包', async () => {
    const result = await createFavoriteEmojiBundle([source()], async () => {
      throw new Error('https://example.invalid/private?token=do-not-export');
    });
    expect(result.archive.includes(Buffer.from('do-not-export'))).toBe(false);
    expect(readFavoriteEmojiBundle(result.archive)[0]?.issue).toBe('无法读取原图');
  });

  it('冻结元数据并响应取消，取消后不继续读取余项', async () => {
    const original = source();
    const result = await createFavoriteEmojiBundle([original], async () => {
      original.description = '读取期间发生的其他编辑';
      return png;
    });
    expect(readFavoriteEmojiBundle(result.archive)[0]?.description).toBe('合成备注 1');
    const abort = new AbortController();
    const load = vi.fn(async () => png);
    await expect(
      createFavoriteEmojiBundle([source(), source(png, 2)], load, {
        signal: abort.signal,
        progress: () => abort.abort(),
      }),
    ).rejects.toThrow();
    expect(load).toHaveBeenCalledOnce();
  });

  it('超出条数和非法元数据在读图前拒绝', async () => {
    const load = vi.fn(async () => png);
    await expect(
      createFavoriteEmojiBundle(
        Array.from({ length: FAVORITE_EMOJI_MAX_ITEMS + 1 }, () => source()),
        load,
      ),
    ).rejects.toThrow('条目');
    await expect(
      createFavoriteEmojiBundle([{ ...source(), description: 'x'.repeat(257) }], load),
    ).rejects.toThrow('元数据');
    expect(load).not.toHaveBeenCalled();
  });

  it('未知版本、缺清单和额外文件不作为收藏包接受', async () => {
    const { archive } = await createFavoriteEmojiBundle([source()], async () => png);
    expect(() =>
      readFavoriteEmojiBundle(
        changeManifest(archive, (value) => {
          value.version = FAVORITE_EMOJI_BUNDLE_VERSION + 1;
        }),
      ),
    ).toThrow('版本');
    expect(() =>
      readFavoriteEmojiBundle(
        buildZip(readZipEntries(archive).filter((entry) => entry.name !== FAVORITE_EMOJI_MANIFEST)),
      ),
    ).toThrow('清单');
    expect(() =>
      readFavoriteEmojiBundle(
        buildZip([...readZipEntries(archive), { name: 'unexpected.txt', data: Buffer.from('x') }]),
      ),
    ).toThrow('未知文件');
  });
  it('拒绝不可解析的清单，空备注与空收藏可正常往返', async () => {
    const invalid = buildZip([{ name: FAVORITE_EMOJI_MANIFEST, data: Buffer.from([0xff]) }]);
    expect(() => readFavoriteEmojiBundle(invalid)).toThrow('UTF-8 JSON');
    const empty = await createFavoriteEmojiBundle([], async () => null);
    expect(readFavoriteEmojiBundle(empty.archive)).toEqual([]);
    const cleared = await createFavoriteEmojiBundle(
      [{ ...source(), description: '' }],
      async () => png,
    );
    expect(readFavoriteEmojiBundle(cleared.archive)[0]?.description).toBe('');
  });

  it('图片缺失或与清单不符时保留其余可预览项', async () => {
    const { archive } = await createFavoriteEmojiBundle(
      [source(png, 1), source(gif, 2)],
      async (entry) => (entry.position === 1 ? png : gif),
    );
    const changed = changeManifest(archive, (value) => {
      const image = value.entries[0]!.image as Record<string, unknown>;
      image.sha256 = '0'.repeat(64);
    });
    expect(readFavoriteEmojiBundle(changed).map((entry) => entry.issue === null)).toEqual([
      false,
      true,
    ]);
    const firstImage = readFavoriteEmojiBundle(archive)[0]!.image!;
    const missing = buildZip(
      readZipEntries(archive).filter((entry) => entry.name !== firstImage.file),
    );
    expect(readFavoriteEmojiBundle(missing)[0]?.issue).toContain('图片缺失');
    const badMetadata = changeManifest(archive, (value) => {
      value.entries[0]!.description = 42;
    });
    expect(readFavoriteEmojiBundle(badMetadata).map((entry) => entry.issue === null)).toEqual([
      false,
      true,
    ]);
  });

  it('按远端 MD5 与包内内容去重，已有收藏不覆盖备注', async () => {
    const { archive } = await createFavoriteEmojiBundle(
      [source(png, 1), source(gif, 2), source(png, 3)],
      async (entry) => (entry.position === 2 ? gif : png),
    );
    const items = readFavoriteEmojiBundle(archive);
    expect(planFavoriteEmojiImport(items, []).map((entry) => entry.disposition)).toEqual([
      'ready',
      'ready',
      'duplicate',
    ]);
    const existing = planFavoriteEmojiImport(items, [md5(png).toUpperCase()]);
    expect(existing.map((entry) => entry.disposition)).toEqual(['exists', 'ready', 'exists']);
    expect(existing[0]?.description).toBe(items[0]?.description);
    expect(() => planFavoriteEmojiImport(items, ['unknown'])).toThrow('远端');
  });
});
