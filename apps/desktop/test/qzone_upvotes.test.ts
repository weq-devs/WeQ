import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  QzonePostUpvotes,
  QzoneUpvoteAction,
} from '../src/renderer/src/components/QzoneUpvoteAction';
import type { QzoneUpvotePreview } from '@weq/protocol';

const state = vi.hoisted(() => ({ read: vi.fn(), people: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  useQQAction: () => ({ disabled: true, pending: false }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared.shared', () => ({
  useQQAction: () => ({ disabled: true, pending: false }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qzone: {
        archiveState: {
          query: async (...args: unknown[]) => ({
            rawStatus: 2,
            capabilitiesObserved: true,
            tag: null,
            showUpvote: true,
            canContribute: false,
            canUncontribute: false,
            canUnarchive: false,
            upvote: await state.read(...args),
          }),
        },
        people: { query: state.people },
        cancel: { mutate: state.cancel },
      },
    },
  },
}));
const value: QzoneUpvotePreview = {
  count: 199,
  upvoted: true,
  users: [
    { uin: '10002', uid: '', nickname: '合成推用户' },
    { uin: '', uid: 'public-user', nickname: '合成空友' },
  ],
};
let close: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.read.mockReset().mockResolvedValue(value);
  state.cancel.mockClear();
  state.people.mockReset().mockResolvedValue({ '10002': '补全的昵称' });
});
afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  return {
    host,
    render: async (next = element) => {
      await act(async () => root.render(next));
    },
  };
}
it('像赞一样悬停或聚焦查看推预览，用户导航和写动作互不触发', async () => {
  const write = vi.fn(),
    space = vi.fn();
  const view = mount(h(QzoneUpvoteAction, { value, onClick: write, onSpace: space }));
  await view.render();
  const button = view.host.querySelector<HTMLButtonElement>('[aria-label="取消推"]')!;
  expect(button.textContent).toBe('推 199');
  expect(document.querySelector('[aria-label="推的人"]')).toBeNull();
  await act(async () => button.focus());
  const panel = document.querySelector<HTMLElement>('[aria-label="推的人"]')!;
  expect(panel.textContent).toContain('已显示 2 人，共 199 人推过');
  expect(panel.textContent).toContain('合成空友');
  await act(async () =>
    panel.querySelector<HTMLButtonElement>('[aria-label="进入 合成推用户 的空间"]')!.click(),
  );
  expect(space).toHaveBeenCalledWith('10002', '合成推用户');
  expect(write).not.toHaveBeenCalled();
  expect(panel.querySelectorAll('button')).toHaveLength(1);
  await act(async () => button.click());
  expect(write).toHaveBeenCalledOnce();
});
it.each([null, { count: 0, upvoted: false, users: [] }])(
  '零人和未知分别展示，不用预览长度冒充总数 %j',
  async (data) => {
    const view = mount(h(QzoneUpvoteAction, { value: data }));
    await view.render();
    const button = view.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe(data ? '推 0' : '推 ?');
    await act(async () => button.focus());
    expect(document.querySelector('[aria-label="推的人"]')?.textContent).toContain(
      data ? '还没有人推过' : '暂无可读取的推数据',
    );
  },
);
it('普通说说仅可见时读取，刷新重取，原位重试保留已有计数', async () => {
  const input = {
    selfUin: '10001',
    hostUin: '10002',
    tid: 'post',
    time: 1700000000,
    enabled: false,
    refresh: 0,
  };
  const view = mount(h(QzonePostUpvotes, input));
  await view.render();
  expect(state.read).not.toHaveBeenCalled();
  await view.render(h(QzonePostUpvotes, { ...input, enabled: true }));
  expect(state.read).toHaveBeenCalledOnce();
  expect(state.read).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selfUin: input.selfUin,
      hostUin: input.hostUin,
      tid: input.tid,
      time: input.time,
      refresh: false,
    }),
  );
  expect(view.host.textContent).toContain('推 199');
  state.read.mockRejectedValueOnce(new Error('合成读取失败'));
  await view.render(h(QzonePostUpvotes, { ...input, enabled: true, refresh: 1 }));
  expect(state.read).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
  await act(async () => view.host.querySelector<HTMLButtonElement>('button')!.focus());
  expect(document.querySelector('[aria-label="推的人"]')?.textContent).toContain('合成读取失败');
  expect(view.host.textContent).toContain('推 199');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="刷新推预览"]')!.click(),
  );
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(document.querySelector('[aria-label="推的人"]')?.textContent).not.toContain(
    '合成读取失败',
  );
  await view.render(h(QzonePostUpvotes, { ...input, enabled: false, refresh: 1 }));
  await view.render(h(QzonePostUpvotes, { ...input, enabled: true, refresh: 1 }));
  // 同一刷新轮次再次进入可见区不重复读。
  expect(state.read).toHaveBeenCalledTimes(3);
});
it('隐藏或卸载后的迟到响应不污染计数，缺失发帖时间不猜测', async () => {
  let finish!: (value: QzoneUpvotePreview) => void;
  state.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = {
    selfUin: '10001',
    hostUin: '10002',
    tid: 'post',
    time: 1,
    enabled: true,
    refresh: 0,
  };
  const view = mount(h(QzonePostUpvotes, input));
  await view.render();
  await view.render(h(QzonePostUpvotes, { ...input, enabled: false }));
  await act(async () => finish(value));
  expect(view.host.textContent).not.toContain('推');
  await view.render(h(QzonePostUpvotes, { ...input, time: 0 }));
  expect(state.read).toHaveBeenCalledOnce();
});
it('真实预览仅有 QQ 号时后台补昵称，名字未返回也先展示人数', async () => {
  let finish!: (names: Record<string, string>) => void;
  state.people.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  state.read.mockResolvedValueOnce({ ...value, users: [{ uin: '10002', uid: '', nickname: '' }] });
  const view = mount(
    h(QzonePostUpvotes, {
      selfUin: '10001',
      hostUin: '10003',
      tid: 'post',
      time: 1,
      enabled: true,
      refresh: 0,
    }),
  );
  await view.render();
  expect(view.host.textContent).toContain('推 199');
  await act(async () => view.host.querySelector<HTMLButtonElement>('button')!.focus());
  expect(document.querySelector('[aria-label="推的人"]')?.textContent).toContain('10002');
  await act(async () => finish({ '10002': '补全的昵称' }));
  expect(document.querySelector('[aria-label="推的人"]')?.textContent).toContain('补全的昵称');
  expect(state.read).toHaveBeenCalledOnce();
});
