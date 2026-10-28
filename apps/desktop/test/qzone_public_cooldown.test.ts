import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzonePublicPane } from '../src/renderer/src/views/QzonePublicView';
import { QzonePageContext } from '../src/renderer/src/views/qzoneShared';

const state = vi.hoisted(() => ({
  minutes: 60,
  feeds: vi.fn(async (_input: { selfUin: string; cursor?: string }) => ({
    feeds: [] as Record<string, unknown>[],
    has_more: false,
    next_cursor: '',
  })),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      getSettings: { query: async () => ({ qzonePublicRefreshCooldownMinutes: state.minutes }) },
    },
    account: {
      qzonePublic: {
        me: { query: async () => ({}) },
        capabilities: { query: async () => ({ public_qzone_entrance_switch: true }) },
        feeds: { query: state.feeds },
        cancel: { mutate: async () => {} },
      },
    },
  },
}));

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.minutes = 60;
});

function mount(uin: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanup = () => act(() => root.unmount());
  return {
    host,
    render: (show: boolean, refresh = 0) =>
      act(async () =>
        root.render(
          h(
            QzonePageContext.Provider,
            {
              value: { active: true, refresh },
            },
            show ? h(QzonePublicPane, { selfUin: uin }) : null,
          ),
        ),
      ),
  };
}

it('首次进入刷新，卸载重建和活动代数变化在冷却期内不换首页，到期后回访刷新', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T00:00:00+08:00'));
  const page = mount('cooldown-default');
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(1);
  await page.render(false);
  vi.setSystemTime(Date.now() + 59 * 60_000);
  await page.render(true, 1);
  await page.render(true, 2);
  expect(state.feeds).toHaveBeenCalledTimes(1);
  await page.render(false);
  vi.setSystemTime(Date.now() + 60_000);
  await page.render(true, 3);
  expect(state.feeds).toHaveBeenCalledTimes(2);
});

it('换一批可绕过冷却期，并从手动刷新成功时重新计时', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T01:00:00+08:00'));
  const page = mount('cooldown-manual');
  await page.render(true);
  vi.setSystemTime(Date.now() + 30 * 60_000);
  const button = [...page.host.querySelectorAll('button')].find(
    (item) => item.textContent === '换一批',
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(state.feeds).toHaveBeenCalledTimes(2);
  await page.render(false);
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(2);
});

it('配置冷却期即时用于下次进入，0 分钟每次进入都换首页', async () => {
  const page = mount('cooldown-setting');
  await page.render(true);
  await page.render(false);
  state.minutes = 0;
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(2);
});

it('失败不进入冷却期，首次读取空列表仍进入冷却期', async () => {
  state.feeds.mockRejectedValueOnce(new Error('合成加载失败'));
  const page = mount('cooldown-failure');
  await page.render(true);
  expect(page.host.textContent).toContain('合成加载失败');
  await page.render(false);
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(2);
  await page.render(false);
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(2);
});

it('冷却期回访保留续页游标，加载更多不从首页重新开始', async () => {
  state.feeds.mockResolvedValueOnce({ feeds: [], has_more: true, next_cursor: 'page-2' });
  const page = mount('cooldown-pagination');
  await page.render(true);
  await page.render(false);
  await page.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(1);
  const more = [...page.host.querySelectorAll('button')].find(
    (item) => item.textContent === '加载更多推荐',
  );
  await act(async () => more!.click());
  expect(state.feeds).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'page-2' }));
});

it('冷却期卸载重建后仍展示原来已加载的正文', async () => {
  state.feeds.mockResolvedValueOnce({
    feeds: [
      {
        cell_common: { union_id: { uf_key: 'cached-post' }, time: '1' },
        cell_user_info: { user: { uid: 'author', nick: '合成作者' } },
        cell_summary: { summary: [{ type: 0, content: '冷却期保留的合成正文' }] },
      },
    ],
    has_more: false,
    next_cursor: '',
  });
  const page = mount('cooldown-content');
  await page.render(true);
  expect(page.host.textContent).toContain('冷却期保留的合成正文');
  await page.render(false);
  await page.render(true);
  expect(page.host.textContent).toContain('冷却期保留的合成正文');
  expect(state.feeds).toHaveBeenCalledTimes(1);
});

it('不同账号独立首次刷新，运行期重置后同账号首次进入仍刷新', async () => {
  const first = mount('cooldown-session');
  await first.render(true);
  await first.render(false);
  await first.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(1);
  cleanup?.();
  const second = mount('cooldown-other-account');
  await second.render(true);
  expect(state.feeds).toHaveBeenCalledTimes(2);
  cleanup?.();
  // 重新装载模块模拟新的渲染运行期，不沿用上一次启动的推荐缓存。
  vi.resetModules();
  const { QzonePublicPane: FreshPane } = await import('../src/renderer/src/views/QzonePublicView');
  const root = createRoot(document.createElement('div'));
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(h(FreshPane, { selfUin: 'cooldown-session' })));
  expect(state.feeds).toHaveBeenCalledTimes(3);
});
