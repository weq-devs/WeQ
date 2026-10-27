import { describe, expect, it, vi } from 'vitest';
import {
  captureReadingPosition,
  restoreReadingPosition,
} from '../src/renderer/src/lib/conversationReadingPosition';
import { registerTimelineViewport } from '../src/renderer/src/lib/timelineViewport';

function fixture(count: number) {
  const scroll = document.createElement('div');
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 400));
  Object.defineProperty(scroll, 'clientHeight', { value: 400 });
  const reads = vi.fn();
  for (let i = 0; i < count; i++) {
    const line = document.createElement('div');
    line.className = 'message-line';
    line.dataset.messageId = `row-${i}`;
    vi.spyOn(line, 'getBoundingClientRect').mockImplementation(() => {
      reads();
      return new DOMRect(0, 100 + i * 50 - scroll.scrollTop, 500, 50);
    });
    scroll.append(line);
  }
  return { scroll, reads };
}

describe('阅读锚点', () => {
  it('临时补偿不覆盖发送后跳到底部、主动定位或用户滚动，持久阅读位置仍可恢复', () => {
    const { scroll } = fixture(20);
    let revision = 0;
    const restore = vi.fn(() => true);
    const viewport = {
      scrollRevision: () => revision,
      scrollTo: () => true,
      restore,
      geometry: () => [],
      offset: () => undefined,
      bottom: () => revision++,
    };
    const release = registerTimelineViewport(scroll, viewport);
    const saved = captureReadingPosition(scroll);
    for (const intent of ['bottom', 'locate', 'wheel', 'touch', 'scrollbar']) {
      const pending = captureReadingPosition(scroll, { transient: true });
      if (intent === 'bottom') viewport.bottom();
      else revision++;
      restoreReadingPosition(scroll, pending);
      expect(restore, intent).not.toHaveBeenCalled();
    }
    restoreReadingPosition(scroll, saved);
    expect(restore).toHaveBeenCalledOnce();
    release();
  });
  it('临时补偿可重复校准同一轮布局，但视口重新绑定后不再生效', () => {
    const { scroll } = fixture(20);
    const restore = vi.fn(() => true);
    const viewport = {
      scrollRevision: () => 0,
      scrollTo: () => true,
      restore,
      geometry: () => [],
      offset: () => undefined,
      bottom: () => {},
    };
    const release = registerTimelineViewport(scroll, viewport);
    const pending = captureReadingPosition(scroll, { transient: true });
    restoreReadingPosition(scroll, pending);
    restoreReadingPosition(scroll, pending);
    expect(restore).toHaveBeenCalledTimes(2);
    release();
    const releaseNew = registerTimelineViewport(scroll, { ...viewport });
    restoreReadingPosition(scroll, pending);
    expect(restore).toHaveBeenCalledTimes(2);
    releaseNew();
  });
  it('隐藏视口的临时快照不污染持久位置，恢复显示后的新意图仍能取消旧补偿', () => {
    const { scroll } = fixture(0);
    const suspended = { scrollTop: 500, anchorId: 'saved' };
    let revision = 0;
    const restore = vi.fn(() => true);
    const release = registerTimelineViewport(scroll, {
      capture: () => suspended,
      scrollRevision: () => revision,
      scrollTo: () => true,
      restore,
      geometry: () => [],
      offset: () => undefined,
      bottom: () => {},
    });
    const pending = captureReadingPosition(scroll, { transient: true });
    expect(pending).not.toBe(suspended);
    revision++;
    restoreReadingPosition(scroll, pending);
    expect(restore).not.toHaveBeenCalled();
    restoreReadingPosition(scroll, suspended);
    expect(restore).toHaveBeenCalledOnce();
    release();
  });
  it('记录首个可见消息和像素偏移，不逐条测量长历史', () => {
    const { scroll, reads } = fixture(10_000);
    scroll.scrollTop = 450_012;
    expect(captureReadingPosition(scroll)).toEqual({
      scrollTop: 450_012,
      anchorId: 'row-9000',
      offset: -12,
    });
    expect(reads.mock.calls.length).toBeLessThan(20);
  });
  it('消息前面有新增或裁剪时，仍按锚点而非旧绝对高度恢复', () => {
    const { scroll } = fixture(20);
    restoreReadingPosition(scroll, { scrollTop: 9000, anchorId: 'row-5', offset: -12 });
    expect(scroll.scrollTop).toBe(262);
  });
  it('即使新页已追加，首次进入也只定位到最后已读行的下沿', () => {
    const { scroll } = fixture(20);
    restoreReadingPosition(scroll, { scrollTop: 0, anchorId: 'row-10', alignToEnd: true });
    expect(scroll.scrollTop).toBe(150);
    restoreReadingPosition(scroll, {
      scrollTop: 0,
      anchorId: 'row-10',
      alignToEnd: true,
      bottomInset: 64,
    });
    expect(scroll.scrollTop).toBe(214);
  });
  it('空窗口或锚点消息被删除时使用像素位置兜底', () => {
    const { scroll } = fixture(0);
    expect(captureReadingPosition(scroll).anchorId).toBeUndefined();
    restoreReadingPosition(scroll, { scrollTop: 120, anchorId: 'removed' });
    expect(scroll.scrollTop).toBe(120);
  });
  it('翻页只补偿可见消息上方的变化，不把底部图片展开和新消息高度算进去', () => {
    const { scroll } = fixture(20);
    scroll.scrollTop = 212;
    const position = captureReadingPosition(scroll);
    let prependedHeight = 0;
    for (const [i, line] of [...scroll.children].entries()) {
      vi.spyOn(line, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, 100 + prependedHeight + i * 50 - scroll.scrollTop, 500, 50),
      );
    }
    prependedHeight = 300;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 5000 });
    restoreReadingPosition(scroll, position);
    expect(scroll.scrollTop).toBe(512);
    restoreReadingPosition(scroll, position);
    expect(scroll.scrollTop).toBe(512);
  });
});
