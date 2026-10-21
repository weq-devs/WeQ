/**
 * `emoji_export`（导出表情包后端）的单测。
 *
 * 覆盖两条策略的关键分支：
 *   - own      ：本地原图优先 → 缺原图走下载 → 下载失败退到缩略图 → 都没有放弃；
 *   - received ：本地原图优先 → 只有缩略图时缩略图补全；
 * 以及 hash 归并（`_<size>` 后缀）、下载后按真实文件头定名、无重复文件名。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectOwnItems,
  collectReceivedItems,
  previewFromPath,
  resolveOwnOriginals,
  writeEmojiBundle,
} from '../src/account/export/emoji_export';

const GIF = Buffer.from('4749463839610100010000003b', 'hex'); // GIF89a minimal
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'weq-emoji-export-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function put(root: string, rel: string, bytes: Buffer): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
}

describe('collectOwnItems', () => {
  it('merges db rows with local files and keeps download address', async () => {
    const root = tmp();
    const personal = join(root, 'personal_emoji');
    const oriLocal = put(personal, 'Ori/AABBCCDDEEFF00112233445566778899.jpg', JPEG);
    const thumbMissing = join(personal, 'Thumb/AABBCCDDEEFF00112233445566778899.png');
    const items = await collectOwnItems(
      [
        // 第一条：原图在本地。
        {
          hash: 'AABBCCDDEEFF00112233445566778899',
          oriPath: oriLocal,
          thumbPath: thumbMissing,
          remoteUrl: 'https://cdn/1',
        },
        // 第二条：本地都没有，但有在线地址。
        {
          hash: '112233445566778899AABBCCDDEEFF00',
          oriPath: join(personal, 'Ori/112233445566778899AABBCCDDEEFF00.jpg'),
          thumbPath: '',
          remoteUrl: 'https://cdn/2',
        },
      ],
      personal,
    );
    expect(items).toHaveLength(2);
    const first = items.find((i) => i.key === 'aabbccddeeff00112233445566778899')!;
    expect(first.oriPath).toBe(oriLocal);
    expect(first.thumbPath).toBeNull();
    expect(first.preview?.scope).toBe('personal');
    const second = items.find((i) => i.key === '112233445566778899aabbccddeeff00')!;
    expect(second.oriPath).toBeNull();
    expect(second.remoteUrl).toBe('https://cdn/2');
  });
});

describe('collectReceivedItems', () => {
  it('merges multi-month buckets and thumb-only entries', async () => {
    const root = tmp();
    const recv = join(root, 'emoji-recv');
    put(recv, '2026-09/Ori/AAAABBBBCCCCDDDDEEEEFFFF00001111.gif', GIF);
    put(recv, '2026-10/Thumb/11112222333344445555666677778888_720.png', PNG);
    const items = await collectReceivedItems(recv);
    expect(items).toHaveLength(2);
    const ori = items.find((i) => i.key === 'aaaabbbbccccddddeeeeffff00001111')!;
    expect(ori.oriPath).toBeTruthy();
    expect(ori.preview?.scope).toBe('recv');
    expect(ori.preview?.bucket).toBe('2026-09');
    const thumb = items.find((i) => i.key === '11112222333344445555666677778888')!;
    expect(thumb.oriPath).toBeNull();
    expect(thumb.thumbPath).toBeTruthy();
    expect(thumb.preview?.variant).toBe('thumb');
  });
});

describe('resolveOwnOriginals + writeEmojiBundle', () => {
  it('QQ 缓存名为 jpg 的 GIF 和 PNG 按真实内容导出，保留全部原始字节', async () => {
    const root = tmp();
    const result = await writeEmojiBundle(
      'own',
      [
        {
          key: 'aaa111',
          oriPath: put(root, 'ori/aaa111.jpg', GIF),
          thumbPath: null,
          remoteUrl: null,
        },
        {
          key: 'bbb222',
          oriPath: put(root, 'ori/bbb222.jpg', PNG),
          thumbPath: null,
          remoteUrl: null,
        },
      ],
      join(root, 'out'),
    );
    expect(readFileSync(join(result.dir, 'aaa111.gif'))).toEqual(GIF);
    expect(readFileSync(join(result.dir, 'bbb222.png'))).toEqual(PNG);
    expect(existsSync(join(result.dir, 'aaa111.jpg'))).toBe(false);
  });
  it('downloads missing originals, sniffs the real ext, and falls back to thumb', async () => {
    const root = tmp();
    const dl = join(root, 'dl');
    const items = [
      { key: 'aaa111', oriPath: null, thumbPath: null, remoteUrl: 'https://cdn/a' }, // 下载 GIF
      { key: 'bbb222', oriPath: null, thumbPath: null, remoteUrl: 'https://cdn/b' }, // 下载 JPEG
      { key: 'ccc333', oriPath: null, thumbPath: null, remoteUrl: 'https://cdn/c' }, // 下载失败、无缩略图
      {
        key: 'ddd444',
        oriPath: null,
        thumbPath: put(root, 'personal_emoji/Thumb/ddd444.png', PNG),
        remoteUrl: 'https://cdn/d',
      }, // 失败 → 缩略图
    ];
    const results: Record<string, Buffer> = { 'https://cdn/a': GIF, 'https://cdn/b': JPEG };
    const r = await resolveOwnOriginals(items, dl, async (url, dest) => {
      const bytes = results[url];
      if (!bytes) return false;
      writeFileSync(dest, bytes);
      return true;
    });
    expect(r.candidates).toBe(4);
    expect(r.downloaded).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.items.find((i) => i.key === 'aaa111')!.oriPath).toBe(join(dl, 'aaa111.gif'));
    expect(r.items.find((i) => i.key === 'bbb222')!.oriPath).toBe(join(dl, 'bbb222.jpg'));
    expect(r.items.find((i) => i.key === 'ccc333')!.oriPath).toBeNull();

    const w = await writeEmojiBundle('own', r.items, join(root, 'out'));
    expect(w.written).toBe(3); // a + b (下载) + d (缩略图)
    expect(w.fromThumb).toBe(1);
    expect(w.skipped).toBe(1);
    expect(w.failures[0]?.error).toContain('没有原图');
    expect(existsSync(w.dir)).toBe(true);
  });
});

describe('previewFromPath', () => {
  it('maps personal / recv paths and rejects unknown', () => {
    expect(previewFromPath('/x/nt_data/Emoji/personal_emoji/Thumb/AB.png')).toEqual({
      scope: 'personal',
      bucket: '',
      variant: 'thumb',
      file: 'AB.png',
    });
    expect(previewFromPath('/x/Emoji/emoji-recv/2026-09/Ori/AB.gif')).toEqual({
      scope: 'recv',
      bucket: '2026-09',
      variant: 'ori',
      file: 'AB.gif',
    });
    expect(previewFromPath('/tmp/whatever.png')).toBeUndefined();
  });
});
