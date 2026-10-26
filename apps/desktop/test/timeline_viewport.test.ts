import { expect, it, vi } from 'vitest';
import {
  registerTimelineViewport,
  revealTimelineMessage,
  timelineViewport,
} from '../src/renderer/src/lib/timelineViewport';
import { restoreReadingPosition } from '../src/renderer/src/lib/conversationReadingPosition';

it('已加载但未挂载的消息交给虚拟视口，旧视口清理不删除新绑定，恢复不退化成原始 scrollTop', () => {
  const scroll = document.createElement('div');
  const viewport = {
    scrollTo: vi.fn(() => true),
    restore: vi.fn(() => true),
    offset: vi.fn(),
    geometry: vi.fn(() => []),
    bottom: vi.fn(),
  };
  const first = registerTimelineViewport(scroll, viewport);
  expect(revealTimelineMessage(scroll, 'unmounted', true)).toBe(true);
  expect(viewport.scrollTo).toHaveBeenCalledWith('unmounted', { align: 'center', flash: true });
  restoreReadingPosition(scroll, { scrollTop: 20000, anchorId: 'unmounted', offset: -10 });
  expect(viewport.restore).toHaveBeenCalledOnce();
  expect(scroll.scrollTop).toBe(0);
  const newer = { ...viewport };
  const second = registerTimelineViewport(scroll, newer);
  first();
  expect(timelineViewport(scroll)).toBe(newer);
  second();
  expect(timelineViewport(scroll)).toBeUndefined();
});
