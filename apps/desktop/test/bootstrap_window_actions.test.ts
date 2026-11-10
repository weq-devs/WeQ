import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BootstrapWindowActions } from '../src/renderer/src/components/BootstrapWindowActions';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const send = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electron', { ipcRenderer: { send } });
  send.mockClear();
  useRestrictedMode.setState({ reasons: [], requests: [], enteringSince: null, open: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(BootstrapWindowActions)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('账号页关闭走现有窗口 IPC，不依赖浏览器关闭接口', () => {
  const browserClose = vi.spyOn(window, 'close');
  act(() => host.querySelector<HTMLButtonElement>('.weq-shell-close-btn')!.click());
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith('window-close');
  expect(browserClose).not.toHaveBeenCalled();
  browserClose.mockRestore();
});

it.each(['restricted', 'entering', 'authorization'])('%s 状态的菜单入口可打开和收起', (state) => {
  act(() =>
    useRestrictedMode.setState({
      reasons: [{ code: 'offline', title: 'QQ 不在线', guidance: '登录 QQ' }],
      enteringSince: state === 'entering' ? Date.now() : null,
      requests:
        state === 'authorization'
          ? [{ kind: 'password', token: 1, title: '管理员授权', message: '合成请求' }]
          : [],
    }),
  );
  const button = host.querySelector<HTMLButtonElement>('.weq-restricted-indicator')!;
  expect(button.disabled).toBe(false);
  act(() => button.click());
  expect(useRestrictedMode.getState().open).toBe(true);
  act(() => button.click());
  expect(useRestrictedMode.getState().open).toBe(false);
});
