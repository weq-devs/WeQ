import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useAccountNoticeUnread } from '../src/renderer/src/hooks/useAccountNoticeUnread';
import { mergeNoticeSeen, type NoticeSeenState } from '../src/shared/notice_seen';

const rpc = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn(), subscribe: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      noticeRead: {
        snapshot: { query: rpc.query },
        merge: { mutate: rpc.mutate },
        changed: { subscribe: rpc.subscribe },
      },
    },
  },
}));
let state: NoticeSeenState | null;
let receive: (state: NoticeSeenState | null) => void;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  window.localStorage.clear();
  state = null;
  rpc.query.mockReset().mockImplementation(async () => state);
  rpc.mutate.mockReset().mockImplementation(async ({ state: next }) => {
    state = mergeNoticeSeen(state, next);
    receive(state);
    return state;
  });
  rpc.subscribe.mockReset().mockImplementation((_binding, callbacks) => {
    receive = callbacks.onData;
    return { unsubscribe: vi.fn() };
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture(kind: 'friend' | 'group') {
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  const prefix = kind === 'friend' ? 'buddy-request:u_a' : 'group-notify:123:u_a';
  const ids = [100, 200, 300].map((time) => `${prefix}:${time}`);
  function Probe({ open = false, account = '10001:source-a' }) {
    return h('span', null, useAccountNoticeUnread(account, kind, ids, open, true));
  }
  const render = async (open = false, account = '10001:source-a', strict = false) => {
    await act(async () =>
      root.render(
        strict ? h(StrictMode, null, h(Probe, { open, account })) : h(Probe, { open, account }),
      ),
    );
  };
  return { host, ids, render };
}
describe('各端通知已读同步接线', () => {
  it.each(['friend', 'group'] as const)(
    '另一端已读覆盖本端旧缓存，之后的新通知仍提示：%s',
    async (kind) => {
      const { host, ids, render } = fixture(kind);
      window.localStorage.setItem(
        `weq:notice-seen:10001:source-a:${kind}`,
        JSON.stringify([ids[0]]),
      );
      state = { seen: ids.slice(0, 2), readThrough: 200 };
      await render();
      expect(host.textContent).toBe('1');
      expect(rpc.mutate).not.toHaveBeenCalled();
      await act(async () => receive({ seen: ids, readThrough: 300 }));
      expect(host.textContent).toBe('0');
      expect(
        JSON.parse(window.localStorage.getItem(`weq:notice-seen:10001:source-a:${kind}`) ?? '{}')
          .readThrough,
      ).toBe(300);
    },
  );
  it.each(['friend', 'group'] as const)(
    '迁移本端旧已读但不自动读掉新增，查看后上传：%s',
    async (kind) => {
      const { host, ids, render } = fixture(kind);
      window.localStorage.setItem(
        `weq:notice-seen:10001:source-a:${kind}`,
        JSON.stringify([ids[0]]),
      );
      await render();
      expect(host.textContent).toBe('2');
      expect(state?.seen).toEqual([ids[0]]);
      await render(true);
      expect(state?.seen).toEqual(ids);
      await render();
      expect(host.textContent).toBe('0');
    },
  );
  it('初次读取失败不建立历史基线，聚焦重试成功后只提示真正新增', async () => {
    const { host, ids, render } = fixture('friend');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.query.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(rpc.mutate).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    state = { seen: ids.slice(0, 2), readThrough: 200 };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(host.textContent).toBe('1');
    error.mockRestore();
  });
  it('保存失败后聚焦重试；StrictMode 重订阅后仍可同步', async () => {
    const { host, ids, render } = fixture('group');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state = { seen: [ids[0]!], readThrough: 100 };
    await render(false, '10001:source-a', true);
    expect(host.textContent).toBe('2');
    rpc.mutate.mockRejectedValueOnce(new Error('offline'));
    await render(true, '10001:source-a', true);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(state?.seen).toEqual(ids);
    error.mockRestore();
  });
});
