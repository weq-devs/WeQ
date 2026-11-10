// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { MessageBubbleSkin } from '@weq/service';
import { withMessageBubbles } from '../src/main/ipc/message_bubbles';
import { readFrameBytes } from '../src/renderer/src/lib/frameImageSize';

it('内联底图只解析 PNG 头，不发起受 connect-src 限制的 data URL 请求', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    const url = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB${'A'.repeat(10000)}`;
    expect(await readFrameBytes(url, new AbortController().signal)).toBe(4);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('消息页只查内存，同款只传一份底图，缺失资源不阻塞消息', () => {
  const skin: MessageBubbleSkin = {
    itemId: 21991,
    slice: { left: 4, right: 4, top: 4, bottom: 4 },
    imageSize: { w: 40, h: 40 },
    textColor: '#516196',
    localFile: 'synthetic.png',
    baseImage: `data:image/png;base64,${'a'.repeat(16000)}`,
  };
  const dress = { messageBubble: vi.fn((id: number) => (id === skin.itemId ? skin : undefined)) };
  const rows = Array.from({ length: 200 }, (_, id) => ({
    id,
    decoration: { bubbleId: id === 100 ? 99999 : skin.itemId },
  }));
  const start = performance.now();
  const prepared = withMessageBubbles(rows, dress);
  expect(prepared).toHaveLength(rows.length);
  expect(prepared[100]).toBe(rows[100]);
  expect(dress.messageBubble).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(prepared).split(skin.baseImage!).length - 1).toBe(1);
  expect(withMessageBubbles(prepared, dress)).toBe(prepared);
  expect(performance.now() - start).toBeLessThan(50);
});

it('嵌套转发的缓存气泡在返回前一并携带，空页不查缓存', () => {
  const skin = { itemId: 21991 } as MessageBubbleSkin;
  const dress = { messageBubble: vi.fn(() => skin) };
  const rows = [{ subMsgs: [{ decoration: { bubbleId: skin.itemId } }] }];
  expect(withMessageBubbles(rows, dress)[0]).toMatchObject({ cachedBubbles: [skin] });
  dress.messageBubble.mockClear();
  expect(withMessageBubbles([], dress)).toEqual([]);
  expect(dress.messageBubble).not.toHaveBeenCalled();
});
