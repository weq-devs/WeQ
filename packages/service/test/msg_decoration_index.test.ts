import { describe, expect, it, vi } from 'vitest';
import { MsgDecorationCacheService } from '../src/account/msg_decoration';
import type { DressService } from '../src/account/dress_service';
import type { BubbleSkin } from '../src/account/bubble_skin';

describe('索引就绪后重新解析未命中的消息装扮', () => {
  it('清除失败缓存和猜测挂件，但保留成功解析项', async () => {
    let revision = 0;
    const bubble = { itemId: 1 } as BubbleSkin;
    const fetchBubble = vi.fn(async () => (revision ? bubble : null));
    const fetchFont = vi.fn(async () => {
      if (!revision) throw new Error('索引尚未就绪');
      return { itemId: 2, family: 'font', file: '/cached.ttf', deriveVersion: 1, fx: null };
    });
    const resolvePendantAnimation = vi.fn(async () =>
      revision ? { frameCount: 2, frameTimeMs: 100, repeat: 0 } : null,
    );
    const dress = {
      indexRevision: () => revision,
      fetchBubble,
      fetchFont,
      resolvePendantAnimation,
    } as unknown as DressService;
    const cache = new MsgDecorationCacheService(dress);
    const ids = { bubbleId: 1, fontId: 2, widgetId: 3 };
    expect(await cache.resolve(ids)).toMatchObject({
      bubble: null,
      font: null,
      widget: { animated: false },
    });
    await cache.resolve(ids);
    expect(fetchBubble).toHaveBeenCalledTimes(1);
    revision++;
    expect(await cache.resolve(ids)).toMatchObject({
      bubble,
      font: { itemId: 2 },
      widget: { animated: true },
    });
    revision++;
    await cache.resolve(ids);
    expect(fetchBubble).toHaveBeenCalledTimes(2);
    expect(fetchFont).toHaveBeenCalledTimes(2);
    expect(resolvePendantAnimation).toHaveBeenCalledTimes(2);
  });
});
