import { act, createElement as h, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { dressup: { chatQqShows: { query } } } },
}));
import {
  resetChatQqShowCache,
  requestChatQqShows,
  useChatQqShow,
} from '../src/renderer/src/lib/chatQqShow';
import { qqShowUrl } from '../src/renderer/src/lib/resourceUrl';

let host: HTMLDivElement;
let root: Root;
const observers = new Map<Element, (visible: boolean) => void>();

function Avatar({ uin = '10001', enabled = true }: { uin?: string; enabled?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const info = useChatQqShow(uin, enabled, ref);
  return h('span', { ref, 'data-uin': uin }, info?.url ?? '');
}

function visible(uin: string, value: boolean) {
  const element = host.querySelector(`[data-uin="${uin}"]`)!;
  act(() => observers.get(element)?.(value));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private element?: Element;
      constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(element: Element) {
        this.element = element;
        observers.set(element, (value) => this.callback([{ isIntersecting: value }]));
      }
      disconnect() {
        if (this.element) observers.delete(this.element);
      }
    },
  );
  query.mockReset();
  query.mockImplementation(async ({ uins }: { uins: string[] }) =>
    Object.fromEntries(
      uins.map((uin) => [
        uin,
        { hasShow: true, url: `show:${uin}`, expiresAt: Date.now() + 300_000 },
      ]),
    ),
  );
  resetChatQqShowCache();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetChatQqShowCache();
  observers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('聊天 QQ 秀按需刷新', () => {
  it('挂载和离屏不请求，进入视口后才查，到期刷新仍可见的头像', async () => {
    act(() => root.render(h(Avatar, {})));
    await advance(1000);
    expect(query).not.toHaveBeenCalled();
    visible('10001', true);
    await advance(30);
    expect(query).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('show:10001');
    await advance(300_030);
    expect(query).toHaveBeenCalledTimes(2);
    visible('10001', false);
    await advance(600_000);
    expect(query).toHaveBeenCalledTimes(2);
    visible('10001', true);
    await advance(30);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('相同成员在途去重，无 QQ 秀也按服务端到期时间重新查询', async () => {
    let finish!: (
      value: Record<string, { hasShow: boolean; url: string; expiresAt: number }>,
    ) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => root.render(h(Avatar, {})));
    visible('10001', true);
    await advance(30);
    requestChatQqShows(['10001']);
    await advance(30);
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({ '10001': { hasShow: false, url: '', expiresAt: Date.now() + 1000 } }),
    );
    await advance(999);
    expect(query).toHaveBeenCalledTimes(1);
    await advance(30);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('失败退避后重试，关闭开关不再刷新', async () => {
    query.mockRejectedValueOnce(new Error('offline'));
    act(() => root.render(h(Avatar, {})));
    visible('10001', true);
    await advance(30);
    await advance(30_030);
    expect(query).toHaveBeenCalledTimes(2);
    act(() => root.render(h(Avatar, { enabled: false })));
    await advance(600_000);
    expect(query).toHaveBeenCalledTimes(2);
    act(() => root.render(h(Avatar, {})));
    await advance(1000);
    expect(query).toHaveBeenCalledTimes(2);
    visible('10001', true);
    await advance(30);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('切换账号丢弃旧请求结果，新账号可重新请求同一成员', async () => {
    let finish!: (value: unknown) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => root.render(h(Avatar, {})));
    visible('10001', true);
    await advance(30);
    act(() => resetChatQqShowCache());
    await advance(30);
    await act(async () =>
      finish({ '10001': { hasShow: true, url: 'old-account', expiresAt: Date.now() + 300_000 } }),
    );
    expect(host.textContent).toBe('show:10001');
  });

  it('超过接口上限时按 120 个拆批，不丢成员', async () => {
    requestChatQqShows(Array.from({ length: 130 }, (_, index) => String(10000 + index)));
    await advance(60);
    expect(query.mock.calls.map(([input]) => input.uins.length)).toEqual([120, 10]);
  });

  it('图片地址相同时新到期时间仍触发图片重载，不改变上游 URL', () => {
    const src = 'https://images.qqshow.gtimg.com/images/10001/102.png';
    expect(qqShowUrl(src, 1000)).not.toBe(qqShowUrl(src, 2000));
    expect(new URL(qqShowUrl(src, 2000)).searchParams.get('src')).toBe(src);
  });
});
