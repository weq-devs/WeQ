import { act, createElement, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteStartupReporter } from '../src/renderer/src/components/RemoteStartupReporter';
import { useViewState } from '../src/renderer/src/state/view';

const query = vi.hoisted(() => ({
  config: { isLoading: false, error: null as Error | null },
  business: vi.fn(() => {
    throw Error('启动不应等待业务列表');
  }),
  native: { data: null, error: null },
  install: { isSuccess: true, error: null },
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => query.config },
      getSelfProfile: { useQuery: query.business },
      listRecentContacts: { useQuery: query.business },
    },
    bootstrap: {
      nativeStatus: { useQuery: () => query.native },
      describeInstall: { useQuery: () => query.install },
    },
  },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  root = createRoot(host);
  query.config.isLoading = false;
  query.config.error = null;
  query.business.mockClear();
  useViewState.setState({ view: 'main', homeStage: 'home' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.weqRemoteStartup;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}
const reporter = () => createElement(RemoteStartupReporter);

it('查询全部完成但代码分包仍显示整页加载时不能离开首页', async () => {
  let finish!: (value: { default: () => ReturnType<typeof createElement> }) => void;
  const Surface = lazy(
    () =>
      new Promise<{ default: () => ReturnType<typeof createElement> }>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(
          Suspense,
          { fallback: createElement('div', { 'data-weq-startup-pending': true }, '正在加载…') },
          createElement(Surface),
        ),
        reporter(),
      ),
    ),
  );
  await frame();
  await frame();
  expect(host.textContent).toContain('正在加载');
  expect(window.weqRemoteStartup?.state).toBe('loading');
  expect(window.weqRemoteStartup?.message).toBe('正在加载界面模块');
  await act(async () =>
    finish({
      default: () => createElement('main', { className: 'app-shell-root' }, '合成 WeQ 界面'),
    }),
  );
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  expect(window.weqRemoteStartup?.message).toBe('正在绘制 WeQ 界面');
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
  expect(host.textContent).not.toContain('正在加载');
  expect(query.business).not.toHaveBeenCalled();
});
it('界面内会话列表仍在加载也正常进入，不等待业务数据', async () => {
  await act(async () =>
    root.render(
      createElement(
        'main',
        { className: 'app-shell-root' },
        createElement('section', { role: 'status' }, '会话列表加载中'),
        reporter(),
      ),
    ),
  );
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
  expect(query.business).not.toHaveBeenCalled();
});
it('无关状态持续更新时仍按两次绘制机会放行，不等待整个 DOM 安静', async () => {
  await act(async () =>
    root.render(
      createElement(
        'main',
        { className: 'app-shell-root' },
        createElement('span', { id: 'business-status' }, '业务状态更新中'),
        reporter(),
      ),
    ),
  );
  const status = host.querySelector<HTMLElement>('#business-status')!;
  status.dataset.tick = '1';
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  status.dataset.tick = '2';
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
  status.dataset.tick = '3';
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
});
it('候选绘制帧中重新出现整页加载占位时撤销放行，移除后重新确认', async () => {
  await act(async () =>
    root.render(createElement('main', { className: 'app-shell-root' }, reporter())),
  );
  await frame();
  const pending = document.createElement('div');
  pending.dataset.weqStartupPending = '';
  host.append(pending);
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  pending.remove();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
});
it('隐藏的旧界面不放行；候选绘制帧遇到启动状态变化必须取消', async () => {
  await act(async () =>
    root.render(createElement('main', { className: 'app-shell-root', hidden: true }, reporter())),
  );
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  host.querySelector('main')!.hidden = false;
  await frame();
  await act(async () => useViewState.setState({ homeStage: 'booting' }));
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  expect(window.weqRemoteStartup?.message).toContain('账号工作区');
});
it('账号配置失败回首页；账号选择页同样需要真实挂载', async () => {
  query.config.error = Error('合成配置失败');
  await act(async () => root.render(reporter()));
  expect(window.weqRemoteStartup).toEqual({ state: 'error', message: '合成配置失败' });
  query.config.error = null;
  await act(async () => useViewState.setState({ view: 'bootstrap', homeStage: 'home' }));
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  const surface = document.createElement('main');
  surface.className = 'weq-account-workspace';
  host.append(surface);
  await frame();
  await frame();
  expect(window.weqRemoteStartup?.state).toBe('ready');
});
