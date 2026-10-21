import { createHash } from 'node:crypto';
import { readFile, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import { createFavoriteEmojiBundle } from '../src/account/favorite_emoji_bundle';
import {
  FavoriteEmojiImportSession,
  FAVORITE_EMOJI_PREVIEW_TTL_MS,
} from '../src/account/favorite_emoji_import_session';

const managers: FavoriteEmojiImportSession[] = [];
const ownedPaths = new Set<string>();
const png = Buffer.from(makeSolidPng(2, 3, [10, 20, 30]));
const hash = createHash('md5').update(png).digest('hex');
const emojiId = `20002_0_0_0_${hash.toUpperCase()}_0_0`;
const exclusive = <T>(work: () => Promise<T>) => work();
async function fixture() {
  let ids: string[] = [];
  const port = {
    fetchOnlineFavoriteIds: vi.fn(async () => ids),
    fetchOnlineFavoriteDetails: vi.fn(async () =>
      ids.map((emojiId) => ({ emojiId, desc: '备注' })),
    ),
    addFavorite: vi.fn(
      async (_bytes: Uint8Array, _log?: (message: string) => void, beforeSend?: () => void) => {
        beforeSend?.();
        ids = [emojiId];
        return emojiId;
      },
    ),
    modifyFavoriteDesc: vi.fn(async () => {}),
    moveFavorite: vi.fn(async () => {}),
  };
  const files = { trustPath: vi.fn((path: string) => ownedPaths.add(path)), untrustPath: vi.fn() };
  const manager = new FavoriteEmojiImportSession(port, files);
  managers.push(manager);
  const { archive } = await createFavoriteEmojiBundle(
    [{ emojiId: emojiId.replace('20002', '10001'), md5: hash, description: '备注', position: 1 }],
    async () => png,
  );
  return { manager, port, files, archive };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const path of ownedPaths) await rm(dirname(path), { recursive: true, force: true });
  ownedPaths.clear();
});

describe('账号内收藏导入预览生命周期', () => {
  it('只返回预览地址与元数据，私有原图不进入 IPC，丢弃后撤销预览并删除文件', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    const path = view.items[0]!.previewPath!;
    expect(view).toMatchObject({
      phase: 'ready',
      result: null,
      items: [{ description: '备注', disposition: 'ready' }],
    });
    expect(JSON.stringify(view)).not.toContain('bytes');
    expect(await readFile(path)).toEqual(png);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(f.files.trustPath).toHaveBeenCalledWith(path);
    await f.manager.discard(view.token);
    expect(f.files.untrustPath).toHaveBeenCalledWith(path);
    await expect(stat(path)).rejects.toThrow();
    expect(f.manager.read()).toBeNull();
  });
  it('预览不写 QQ，完成后令牌不可重用，只有后台结果用于显示', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    expect(f.port.addFavorite).not.toHaveBeenCalled();
    const running = f.manager.start(view.token, [view.items[0]!.key], exclusive);
    expect(running.phase).toBe('running');
    expect(() => f.manager.start(view.token, [view.items[0]!.key], exclusive)).toThrow('提交');
    await vi.waitFor(() => expect(f.manager.read()?.phase).toBe('finished'));
    expect(f.manager.read()?.result?.items[0]?.state).toBe('confirmed');
    expect(() => f.manager.start(view.token, [view.items[0]!.key], exclusive)).toThrow('提交');
    expect(f.port.addFavorite).toHaveBeenCalledOnce();
    await f.manager.dispose();
    await expect(stat(view.items[0]!.previewPath!)).rejects.toThrow();
  });
  it('错误令牌、重复选择与不可导入项均不发写请求', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    expect(() => f.manager.start('another-account-token', [view.items[0]!.key], exclusive)).toThrow(
      '过期',
    );
    for (const keys of [[], ['missing'], [view.items[0]!.key, view.items[0]!.key]])
      expect(() => f.manager.start(view.token, keys, exclusive)).toThrow('选择');
    expect(f.port.addFavorite).not.toHaveBeenCalled();
  });
  it('远端已有图片不可勾选导入', async () => {
    const f = await fixture();
    f.port.fetchOnlineFavoriteIds.mockResolvedValue([emojiId]);
    const view = await f.manager.prepare(f.archive, () => {});
    expect(view.items[0]?.disposition).toBe('exists');
    expect(() => f.manager.start(view.token, [view.items[0]!.key], exclusive)).toThrow('选择');
  });
  it('在途上传取消后保持运行直到原请求返回，不允许另开批次或重传', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const add = f.port.addFavorite.getMockImplementation()!;
    f.port.addFavorite.mockImplementationOnce(async (...args) => {
      args[2]?.();
      await gate;
      return add(...args);
    });
    f.manager.start(view.token, [view.items[0]!.key], exclusive);
    await vi.waitFor(() => expect(f.port.addFavorite).toHaveBeenCalledOnce());
    f.manager.cancel(view.token);
    expect(f.manager.read()).toMatchObject({ phase: 'running', cancelling: true });
    await expect(f.manager.prepare(f.archive, () => {})).rejects.toThrow('等待');
    await expect(f.manager.discard(view.token)).rejects.toThrow('在途');
    release();
    await vi.waitFor(() => expect(f.manager.read()?.phase).toBe('finished'));
    expect(f.manager.read()?.result?.items[0]?.state).toBe('unconfirmed');
    expect(f.port.modifyFavoriteDesc).not.toHaveBeenCalled();
  });
  it('账号切换或预览到期均撤销待提交文件，不继续上传', async () => {
    for (const mode of ['account', 'expiry']) {
      const f = await fixture();
      let changed = false;
      const view = await f.manager.prepare(f.archive, () => {
        if (changed) throw new Error('账号或 PID 已改变');
      });
      const path = view.items[0]!.previewPath!;
      if (mode === 'account') changed = true;
      else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + FAVORITE_EMOJI_PREVIEW_TTL_MS + 1);
      expect(() => f.manager.start(view.token, [view.items[0]!.key], exclusive)).toThrow();
      expect(f.manager.read()?.phase).toBe('expired');
      expect(f.files.untrustPath).toHaveBeenCalledWith(path);
      expect(f.port.addFavorite).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it('账号释放后不保留预览，恢复旧页面也无法再次写入', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    const path = view.items[0]!.previewPath!;
    await f.manager.dispose();
    expect(f.manager.read()).toBeNull();
    expect(() => f.manager.start(view.token, [view.items[0]!.key], exclusive)).toThrow();
    await expect(stat(path)).rejects.toThrow();
  });
  it('写锁获取同步失败也保留终态，不遗留永久运行中的会话', async () => {
    const f = await fixture();
    const view = await f.manager.prepare(f.archive, () => {});
    f.manager.start(view.token, [view.items[0]!.key], () => {
      throw new Error('写锁已占用');
    });
    expect(f.manager.read()).toMatchObject({ phase: 'finished', error: '写锁已占用' });
    expect(f.port.addFavorite).not.toHaveBeenCalled();
  });

  it('无人点击时也按时撤销和清理预览，而不触发 QQ 写入', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const view = await f.manager.prepare(f.archive, () => {});
    const path = view.items[0]!.previewPath!;
    await vi.advanceTimersByTimeAsync(FAVORITE_EMOJI_PREVIEW_TTL_MS);
    vi.useRealTimers();
    expect(f.manager.read()).toBeNull();
    expect(f.files.untrustPath).toHaveBeenCalledWith(path);
    await vi.waitFor(async () => {
      await expect(stat(path)).rejects.toThrow();
    });
    expect(f.port.addFavorite).not.toHaveBeenCalled();
  });

  it('大文件读取之前先占用准备互斥，重复请求不并行分配多份收藏包', async () => {
    const f = await fixture();
    let release!: (bytes: Buffer) => void;
    const gate = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(() => gate);
    const preparing = f.manager.prepare(load, () => {});
    await expect(f.manager.prepare(load, () => {})).rejects.toThrow('等待');
    release(f.archive);
    await preparing;
    expect(load).toHaveBeenCalledOnce();
    expect(f.port.addFavorite).not.toHaveBeenCalled();
  });
});
