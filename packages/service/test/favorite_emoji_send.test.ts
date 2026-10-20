import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAVORITE_EMOJI_MAX_BYTES,
  prepareFavoriteEmojiElements,
} from '../src/account/favorite_emoji_send';

const hash = 'aabbccddeeff00112233445566778899';
const gif = Buffer.from('4749463839610100010000003b', 'hex');
const source = {
  kind: 'favoriteEmoji',
  scope: 'personal',
  bucket: '',
  variant: 'thumb',
  file: `${hash}.png`,
};
const row = {
  hash,
  oriPath: `/qq/emoji-recv/2026-09/Ori/${hash}.gif`,
  thumbPath: `/qq/personal_emoji/Thumb/${hash}.png`,
  remoteUrl: 'https://example.invalid/original',
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(bytes = gif) {
  const dir = await mkdtemp(join(tmpdir(), 'weq-favorite-test-'));
  dirs.push(dir);
  const path = join(dir, 'original');
  await writeFile(path, bytes);
  const deps = {
    listRows: vi.fn(async () => [row]),
    resolveFile: vi.fn(async () => path as string | null),
    checkCurrent: vi.fn(),
    download: vi.fn(async (_url: string, target: string) => {
      await writeFile(target, gif);
      return { ok: true as const, bytes: gif.length, sha256: '', contentType: 'image/gif' };
    }),
  };
  return { path, deps };
}
describe('收藏表情发送资源', () => {
  it('静态 PNG 保留原始内容并按真实格式上传', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082',
      'hex',
    );
    const { deps } = await setup(png);
    expect(
      (await prepareFavoriteEmojiElements([{ kind: 'image', source }], deps))[0],
    ).toMatchObject({ source: png, picFormat: 1001, fileName: `${hash}.png` });
  });
  it('超大原图有界拒绝，普通元素不会读取收藏库', async () => {
    const { deps, path } = await setup();
    await truncate(path, FAVORITE_EMOJI_MAX_BYTES + 1);
    await expect(prepareFavoriteEmojiElements([{ kind: 'image', source }], deps)).rejects.toThrow(
      '20 MiB',
    );
    deps.listRows.mockClear();
    const text = { kind: 'text', textContent: '普通消息' };
    expect(await prepareFavoriteEmojiElements([text], deps)).toEqual([text]);
    expect(deps.listRows).not.toHaveBeenCalled();
  });
  it('缩略图引用按收藏记录定位跨目录原图，保留 GIF 字节和混排顺序', async () => {
    const { deps, path } = await setup();
    const text = { kind: 'text', textContent: '前' };
    const result = await prepareFavoriteEmojiElements(
      [text, { kind: 'image', source }, text],
      deps,
    );
    expect(result[0]).toBe(text);
    expect(result[2]).toBe(text);
    expect(result[1]).toMatchObject({
      kind: 'image',
      source: gif,
      subType: 1,
      picFormat: 2000,
      width: 1,
      height: 1,
    });
    expect(deps.resolveFile).toHaveBeenCalledWith('recv', '2026-09', 'ori', `${hash}.gif`);
    expect(deps.download).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(gif);
  });
  it('原图不在时只下载收藏记录的在线原图，并清理临时文件', async () => {
    const { deps } = await setup();
    deps.resolveFile.mockResolvedValue(null);
    const result = await prepareFavoriteEmojiElements([{ kind: 'image', source }], deps);
    expect(result[0]).toMatchObject({ source: gif, fileName: `${hash}.gif` });
    expect(deps.download).toHaveBeenCalledWith(
      row.remoteUrl,
      expect.any(String),
      expect.objectContaining({ maxBytes: FAVORITE_EMOJI_MAX_BYTES, expectedKind: 'image' }),
    );
    await expect(readFile(deps.download.mock.calls[0]![1])).rejects.toThrow();
  });
  it('损坏原图拒绝发送，不拿静态缩略图冒充原图', async () => {
    const { deps } = await setup(Buffer.from('broken'));
    await expect(prepareFavoriteEmojiElements([{ kind: 'image', source }], deps)).rejects.toThrow(
      '原图',
    );
    expect(deps.resolveFile).toHaveBeenCalledTimes(1);
  });
  it('删除的收藏、伪造路径和非图片逻辑引用都不会读取或下载资源', async () => {
    const { deps } = await setup();
    for (const element of [
      { kind: 'image', source: { ...source, file: '../../secret' } },
      { kind: 'image', source: { ...source, file: `${hash}ff.png` } },
      { kind: 'video', source },
    ]) {
      await expect(prepareFavoriteEmojiElements([element], deps)).rejects.toThrow();
    }
    expect(deps.resolveFile).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });
  it('一条消息重复使用同一收藏仅读取一次，普通图片不变', async () => {
    const { deps } = await setup();
    const normal = { kind: 'image', source: '/local/picture.png' };
    const result = await prepareFavoriteEmojiElements(
      [{ kind: 'image', source }, normal, { kind: 'image', source }],
      deps,
    );
    expect(deps.listRows).toHaveBeenCalledTimes(1);
    expect(deps.resolveFile).toHaveBeenCalledTimes(1);
    expect(result[1]).toBe(normal);
    expect(result[0]).toEqual(result[2]);
  });
  it('异步读收藏后账号来源变动立即停止', async () => {
    const { deps } = await setup();
    deps.listRows.mockImplementation(async () => {
      deps.checkCurrent.mockImplementation(() => {
        throw new Error('来源已切换');
      });
      return [row];
    });
    await expect(prepareFavoriteEmojiElements([{ kind: 'image', source }], deps)).rejects.toThrow(
      '来源已切换',
    );
    expect(deps.resolveFile).not.toHaveBeenCalled();
  });
  it('下载失败不发送，不回退缩略图；临时目录仍被清理', async () => {
    const { deps } = await setup();
    deps.resolveFile.mockResolvedValue(null);
    deps.download.mockImplementation(async () => {
      throw new Error('下载中断');
    });
    await expect(prepareFavoriteEmojiElements([{ kind: 'image', source }], deps)).rejects.toThrow(
      '下载中断',
    );
    await expect(readFile(deps.download.mock.calls[0]![1])).rejects.toThrow();
  });
  it('下载返回时切换来源会丢弃资源并清理临时目录', async () => {
    const { deps } = await setup();
    deps.resolveFile.mockResolvedValue(null);
    deps.download.mockImplementation(async (_url, target) => {
      await writeFile(target, gif);
      deps.checkCurrent.mockImplementation(() => {
        throw new Error('来源已切换');
      });
      return { ok: true, bytes: gif.length, sha256: '', contentType: 'image/gif' };
    });
    await expect(prepareFavoriteEmojiElements([{ kind: 'image', source }], deps)).rejects.toThrow(
      '来源已切换',
    );
    await expect(readFile(deps.download.mock.calls[0]![1])).rejects.toThrow();
  });
});
