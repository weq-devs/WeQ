import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import {
  createFavoriteEmojiBundle,
  readFavoriteEmojiBundle,
} from '../src/account/favorite_emoji_bundle';
import { runFavoriteEmojiImport } from '../src/account/favorite_emoji_import';

const png = (value: number) => Buffer.from(makeSolidPng(2, 3, [value, 20, 30]));
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex').toUpperCase();
const id = (bytes: Uint8Array, account = '20002') => `${account}_0_0_0_${md5(bytes)}_0_0`;
async function fixture() {
  const images = [png(10), png(40), png(70)];
  const { archive } = await createFavoriteEmojiBundle(
    images.map((bytes, index) => ({
      emojiId: id(bytes, '10001'),
      md5: md5(bytes),
      description: `备注 ${index + 1}`,
      position: index + 1,
    })),
    async (source) => images[source.position - 1]!,
  );
  return { items: readFavoriteEmojiBundle(archive), images };
}
function server() {
  let ids: string[] = [id(png(90))];
  const descriptions = new Map<string, string>();
  const port = {
    fetchOnlineFavoriteIds: vi.fn(async () => [...ids]),
    fetchOnlineFavoriteDetails: vi.fn(async () =>
      ids.map((emojiId) => ({ emojiId, desc: descriptions.get(emojiId) ?? '' })),
    ),
    addFavorite: vi.fn(
      async (bytes: Uint8Array, _log?: (message: string) => void, beforeSend?: () => void) => {
        beforeSend?.();
        const emojiId = id(bytes);
        ids.unshift(emojiId);
        return emojiId;
      },
    ),
    modifyFavoriteDesc: vi.fn(async (emojiId: string, description: string) => {
      descriptions.set(emojiId, description);
    }),
    moveFavorite: vi.fn(async (emojiId: string, position = 1, beforeSend?: () => void) => {
      beforeSend?.();
      ids = ids.filter((value) => value !== emojiId);
      ids.splice(position - 1, 0, emojiId);
    }),
  };
  return { port, ids: () => ids, descriptions };
}

describe('收藏包导入执行', () => {
  it('使用目标账号新 ID，按来源顺序追加，读回确认图片、备注与排序', async () => {
    const { items, images } = await fixture();
    const s = server();
    const original = s.ids()[0]!;
    const progress = vi.fn();
    const result = await runFavoriteEmojiImport(items, [items[2]!.key, items[0]!.key], s.port, {
      current: () => {},
      progress,
    });
    expect(result.stopped).toBeNull();
    expect(result.items.map((row) => row.state)).toEqual(['confirmed', 'confirmed']);
    expect(s.ids()).toEqual([original, id(images[0]!), id(images[2]!)]);
    expect(s.descriptions.get(id(images[0]!))).toBe(items[0]!.description);
    expect(
      s.port.modifyFavoriteDesc.mock.calls.every(([emojiId]) => emojiId.startsWith('20002_')),
    ).toBe(true);
    expect(progress).toHaveBeenCalled();
  });

  it('提交前重新去重，已有项不改备注与位置，未选项不上传', async () => {
    const { items, images } = await fixture();
    const s = server();
    await s.port.addFavorite(images[0]!);
    s.port.addFavorite.mockClear();
    const result = await runFavoriteEmojiImport(items, [items[0]!.key, items[1]!.key], s.port, {
      current: () => {},
    });
    expect(result.items.map((row) => row.state)).toEqual(['exists', 'confirmed']);
    expect(s.port.addFavorite).toHaveBeenCalledOnce();
    expect(s.port.modifyFavoriteDesc).toHaveBeenCalledTimes(1);
    expect(s.port.modifyFavoriteDesc.mock.calls[0]?.[0]).toBe(id(images[1]!));
  });

  it('无效选择在远端读取与写入之前拒绝', async () => {
    const { items } = await fixture();
    const s = server();
    for (const selection of [['unknown'], [items[0]!.key, items[0]!.key]])
      await expect(
        runFavoriteEmojiImport(items, selection, s.port, { current: () => {} }),
      ).rejects.toThrow('选择');
    const invalid = [{ ...items[0]!, issue: '图片校验失败', image: null }];
    await expect(
      runFavoriteEmojiImport(invalid, [invalid[0]!.key], s.port, { current: () => {} }),
    ).rejects.toThrow('选择');
    expect(s.port.fetchOnlineFavoriteIds).not.toHaveBeenCalled();
    expect(s.port.addFavorite).not.toHaveBeenCalled();
  });

  it('上传开始后超时标未确认并停止，不重试、不发后续图片', async () => {
    const { items } = await fixture();
    const s = server();
    s.port.addFavorite.mockImplementationOnce(async (_bytes, _log, beforeSend) => {
      beforeSend?.();
      throw new Error('连接超时');
    });
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {} },
    );
    expect(result.items.map((row) => row.state)).toEqual(['unconfirmed', 'not-run', 'not-run']);
    expect(result.stopped).toContain('未确认');
    expect(s.port.addFavorite).toHaveBeenCalledOnce();
    expect(s.port.modifyFavoriteDesc).not.toHaveBeenCalled();
  });

  it('明确的发送前失败逐项报告，其余图片仍可继续', async () => {
    const { items } = await fixture();
    const s = server();
    s.port.addFavorite.mockRejectedValueOnce(new Error('无可用上传通道'));
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {} },
    );
    expect(result.items.map((row) => row.state)).toEqual(['failed', 'confirmed', 'confirmed']);
    expect(result.stopped).toBeNull();
  });

  it('备注失败不再上传同图，保留新增 ID，并继续排序及其余条目', async () => {
    const { items, images } = await fixture();
    const s = server();
    s.port.modifyFavoriteDesc.mockRejectedValueOnce(new Error('备注被拒绝'));
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {} },
    );
    expect(result.items.map((row) => row.state)).toEqual([
      'metadata-failed',
      'confirmed',
      'confirmed',
    ]);
    expect(result.items[0]).toMatchObject({
      emojiId: id(images[0]!),
      description: 'failed',
      order: 'confirmed',
    });
    expect(s.port.addFavorite).toHaveBeenCalledTimes(3);
  });

  it('取消或账号改变后不再写，已上传项与未执行项分别保留', async () => {
    for (const kind of ['cancel', 'account'] as const) {
      const { items } = await fixture();
      const s = server();
      const abort = new AbortController();
      let changed = false;
      const add = s.port.addFavorite.getMockImplementation()!;
      s.port.addFavorite.mockImplementationOnce(async (...args) => {
        const value = await add(...args);
        if (kind === 'cancel') abort.abort();
        else changed = true;
        return value;
      });
      const result = await runFavoriteEmojiImport(
        items,
        items.map((row) => row.key),
        s.port,
        {
          signal: abort.signal,
          current: () => {
            if (changed) throw new Error('账号已切换');
          },
        },
      );
      expect(result.stopped).toBeTruthy();
      expect(result.items.map((row) => row.state)).toEqual(['accepted', 'not-run', 'not-run']);
      expect(s.port.modifyFavoriteDesc).not.toHaveBeenCalled();
      expect(s.port.moveFavorite).not.toHaveBeenCalled();
    }
  });

  it('上传返回不同图片标识时停止，不对错误对象改备注', async () => {
    const { items } = await fixture();
    const s = server();
    s.port.addFavorite.mockResolvedValueOnce(id(png(200)));
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {} },
    );
    expect(result.items[0]?.state).toBe('unconfirmed');
    expect(result.stopped).toBeTruthy();
    expect(s.port.modifyFavoriteDesc).not.toHaveBeenCalled();
  });

  it('发送后取消且没有拿到新增 ID 时仍标未确认，不能冒称未执行', async () => {
    const { items } = await fixture();
    const s = server();
    const abort = new AbortController();
    s.port.addFavorite.mockImplementationOnce(async (_bytes, _log, beforeSend) => {
      beforeSend?.();
      abort.abort();
      beforeSend?.();
      throw new Error('不会执行到这里');
    });
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {}, signal: abort.signal },
    );
    expect(result.items.map((row) => row.state)).toEqual(['unconfirmed', 'not-run', 'not-run']);
    expect(result.stopped).toContain('取消');
    expect(s.port.addFavorite).toHaveBeenCalledOnce();
  });

  it('错误备注或顺序读回不一致时不提升为确认成功', async () => {
    const { items } = await fixture();
    const s = server();
    s.port.moveFavorite.mockResolvedValue(undefined);
    const result = await runFavoriteEmojiImport(
      items,
      items.map((row) => row.key),
      s.port,
      { current: () => {} },
    );
    expect(result.items.every((row) => row.state === 'metadata-failed')).toBe(true);
    expect(
      result.items.every((row) => row.description === 'confirmed' && row.order === 'accepted'),
    ).toBe(true);
    expect(s.port.addFavorite).toHaveBeenCalledTimes(3);
  });

  it('读取失败不能冒称完整恢复，也不重发写请求', async () => {
    const { items } = await fixture();
    const s = server();
    s.port.fetchOnlineFavoriteDetails.mockRejectedValue(new Error('读取失败'));
    const result = await runFavoriteEmojiImport(items, [items[0]!.key], s.port, {
      current: () => {},
    });
    expect(result.items[0]).toMatchObject({
      state: 'unconfirmed',
      description: 'accepted',
      order: 'accepted',
    });
    expect(s.port.addFavorite).toHaveBeenCalledOnce();
    expect(s.port.modifyFavoriteDesc).toHaveBeenCalledOnce();
  });
});
