import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteStartupReporter } from '../src/renderer/src/components/RemoteStartupReporter';
import { useViewState } from '../src/renderer/src/state/view';

const query = vi.hoisted(() => ({
  config: { isLoading: true, error: null as Error | null },
  profile: { isLoading: false, error: null as Error | null },
  recent: { isLoading: false, error: null as Error | null },
  native: { data: null, error: null },
  install: { isSuccess: false, error: null },
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => query.config },
      getSelfProfile: { useQuery: () => query.profile },
      listRecentContacts: { useQuery: () => query.recent },
    },
    bootstrap: {
      nativeStatus: { useQuery: () => query.native },
      describeInstall: { useQuery: () => query.install },
    },
  },
}));

let close = () => {};
afterEach(() => {
  close();
  delete window.weqRemoteStartup;
  vi.unstubAllGlobals();
});

it('账号首屏未准备好不放行；查询完成后通知并保存可补读的状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ view: 'main', homeStage: 'home' });
  const root = createRoot(document.createElement('div'));
  close = () => act(() => root.unmount());
  const render = () => act(async () => root.render(createElement(RemoteStartupReporter)));
  await render();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  query.config.isLoading = false;
  query.recent.isLoading = true;
  await render();
  expect(window.weqRemoteStartup?.state).toBe('loading');
  const received = vi.fn();
  window.addEventListener('weq-remote-startup', received, { once: true });
  query.recent.isLoading = false;
  await render();
  expect(window.weqRemoteStartup?.state).toBe('ready');
  expect(received).toHaveBeenCalledOnce();
  query.config.error = Error('合成首屏失败');
  await render();
  expect(window.weqRemoteStartup).toEqual({ state: 'error', message: '合成首屏失败' });
  query.config.error = null;
  await act(async () => useViewState.setState({ view: 'bootstrap', homeStage: 'booting' }));
  expect(window.weqRemoteStartup?.state).toBe('loading');
  await act(async () => useViewState.setState({ homeStage: 'home' }));
  expect(window.weqRemoteStartup?.state).toBe('loading');
  query.install.isSuccess = true;
  await render();
  expect(window.weqRemoteStartup?.state).toBe('ready');
});
