import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useAccountNoticeUnread } from '../src/renderer/src/hooks/useAccountNoticeUnread';
import { mergeNoticeSeen, type NoticeReadSnapshot } from '../src/shared/notice_seen';

const rpc = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn(), subscribe: vi.fn() }));
const toast = vi.hoisted(() => ({
  toasts: [] as { id: number }[],
  push: vi.fn(),
  dismiss: vi.fn(),
}));
const pushNotification = toast.push;
vi.mock('../src/renderer/src/components/Toast.shared', () => ({
  useToast: { getState: () => toast },
}));
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
let state: NoticeReadSnapshot | null;
let receive: (state: NoticeReadSnapshot | null) => void;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  window.localStorage.clear();
  toast.toasts = [];
  toast.dismiss.mockClear();
  pushNotification.mockReset().mockImplementation(() => {
    const id = toast.toasts.length + 1;
    toast.toasts.push({ id });
    return id;
  });
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
  it('不通知回填历史、已读或已打开的群通知，只通知新增未读记录', async () => {
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const notice = (time: number, uid = 'u_a') => `group-notify:123:${uid}:${time}`;
    const onOpen = vi.fn();
    function Probe({ ids, open }: { ids: string[]; open: boolean }) {
      useAccountNoticeUnread('10001:source-a', 'group', ids, open, true, {
        title: '收到新的群通知',
        onOpen,
      });
      return null;
    }
    const render = (ids: string[], open = false) =>
      act(async () => root.render(h(Probe, { ids, open })));
    state = { seen: [notice(100)], readThrough: 100 };
    await render([notice(200), notice(100)]);
    await render([notice(200), notice(150), notice(100)]);
    await act(async () => receive({ seen: [notice(300)], readThrough: 300 }));
    await render([notice(300), notice(200)]);
    expect(pushNotification).not.toHaveBeenCalled();

    const newNotice = notice(300, 'u_b');
    await render([newNotice, newNotice, notice(300)]);
    expect(pushNotification).toHaveBeenCalledTimes(1);
    expect(pushNotification).toHaveBeenCalledWith(expect.objectContaining({ event: 'contact' }));
    await render([notice(400), newNotice], true);
    await render([notice(400), newNotice]);
    expect(pushNotification).toHaveBeenCalledTimes(1);
  });
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
  it('已读或已处理的通知只收起对应批次，暂时不在列表不算确认', async () => {
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const first = 'buddy-request:u_a:200';
    const second = 'buddy-request:u_b:200';
    const unrelated = 'buddy-request:u_c:200';
    const onOpen = vi.fn();
    function Probe({ ids, handledIds }: { ids: string[]; handledIds?: ReadonlySet<string> }) {
      useAccountNoticeUnread('10001:source-a', 'friend', ids, false, true, {
        title: '好友通知',
        onOpen,
        handledIds,
      });
      return null;
    }
    const render = (ids: string[], handledIds?: ReadonlySet<string>) =>
      act(async () => root.render(h(Probe, { ids, handledIds })));
    await render([]);
    await render([first, second]);
    await render([first, second, unrelated]);
    expect(pushNotification).toHaveBeenCalledTimes(2);
    await render([first, unrelated]);
    await act(async () => receive({ seen: [first], readThrough: 200 }));
    expect(toast.dismiss).not.toHaveBeenCalled();
    await render([first, second, unrelated], new Set([second]));
    expect(toast.dismiss.mock.calls).toEqual([[1]]);
    await act(async () => receive({ seen: [unrelated], readThrough: 200 }));
    expect(toast.dismiss.mock.calls).toEqual([[1], [2]]);
  });
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
  it('Remote 不查 QQ 也应用分箱水位，迟到的共享快照不重新点亮', async () => {
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const ids = ['normal:200001', 'normal:200002', 'filtered:200001'].map(
      (id) => `group-notify-seq:${id}`,
    );
    let count = -1;
    function Probe() {
      count = useAccountNoticeUnread('10001:source-a', 'group', ids, false, true);
      return null;
    }
    state = { seen: [], readThrough: 0, qqGroupRead: { normal: '200001' } };
    await act(async () => root.render(h(Probe)));
    expect(count).toBe(2);
    await act(async () =>
      receive({ seen: [], readThrough: 0, qqGroupRead: { filtered: '200001' } }),
    );
    expect(count).toBe(1);
    await act(async () => receive({ seen: [], readThrough: 0, qqGroupRead: { normal: '200000' } }));
    expect(count).toBe(1);
    expect(rpc.mutate).not.toHaveBeenCalled();
  });
  it.each(['friend', 'group'] as const)('只提交实际展示的补载条目：%s', async (kind) => {
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const prefix = kind === 'friend' ? 'buddy-request:u_a' : 'group-notify:123:u_a';
    const initial = `${prefix}:100`;
    const during = `${prefix}:200`;
    const after = `${prefix}:300`;
    let count = -1;
    function Probe({ ids, open }: { ids: string[]; open: boolean }) {
      count = useAccountNoticeUnread('10001:source-a', kind, ids, open, true);
      return null;
    }
    rpc.query.mockImplementationOnce(() => new Promise(() => {}));
    const render = (ids: string[], open: boolean) =>
      act(async () => root.render(h(Probe, { ids, open })));
    await render([initial], true);
    await render([initial, during], true);
    await render([initial, during], false);
    await render([initial, during, after], false);
    expect(rpc.mutate).not.toHaveBeenCalled();
    await act(async () => receive(null));
    expect(state?.seen).toEqual([initial, during]);
    expect(count).toBe(1);
  });
  it('已读的旧群通知 ID 对上序号后写回，另一端只拿到在线条目也能去重', async () => {
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const old = 'group-notify:123:u_a:200';
    const canonical = 'group-notify-seq:normal:200001';
    const next = 'group-notify-seq:normal:200002';
    state = { seen: [old], readThrough: 200 };
    let count = -1;
    function Probe({ alias }: { alias: boolean }) {
      count = useAccountNoticeUnread('10001:source-a', 'group', [canonical, next], false, true, {
        title: '群通知',
        onOpen: () => {},
        legacyIds: alias ? new Map([[canonical, old]]) : undefined,
      });
      return null;
    }
    await act(async () => root.render(h(Probe, { alias: true })));
    expect(state?.seen).toContain(canonical);
    await act(async () => root.render(h(Probe, { alias: false })));
    expect(count).toBe(1);
  });
});
