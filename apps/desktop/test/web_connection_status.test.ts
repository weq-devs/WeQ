import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebConnectionStatus } from '../src/renderer/src/components/WebConnectionStatus';
import { useWebConnection } from '../src/renderer/src/state/webConnection';
import { useToast } from '../src/renderer/src/components/Toast';

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
const queryClient = { invalidateQueries };
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(WebConnectionStatus)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  delete window.weqRemoteConnection;
  delete window.weqRemoteShell;
});

it('短暂握手不闪提示，持续连接显示状态，连上即收起', async () => {
  expect(host.textContent).toBe('');
  await act(async () => vi.advanceTimersByTime(1500));
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在连接电脑');
  await act(async () => useWebConnection.getState().connected());
  expect(host.textContent).toBe('');
  expect(invalidateQueries).not.toHaveBeenCalled();
});

it('重连后仅补查活动读取，不重载页面或重放操作', async () => {
  await act(async () => useWebConnection.getState().connected());
  await act(async () => useWebConnection.getState().disconnected());
  await act(async () => vi.advanceTimersByTime(1500));
  expect(host.textContent).toContain('正在重连');
  await act(async () => useWebConnection.getState().connected());
  expect(invalidateQueries).toHaveBeenCalledOnce();
  expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: 'active' });
  expect(host.textContent).toBe('');
});

it('卸载清理提示计时器', async () => {
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});

it('手机壳的断连和恢复复用同一横幅，Wi-Fi 恢复不提前报成功', async () => {
  const connectionFailed = vi.fn();
  window.weqRemoteShell = { openMenu: vi.fn(), connectionFailed };
  window.weqRemoteConnection = { state: 'connected' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(connectionFailed).toHaveBeenCalledOnce();
  expect(useToast.getState().toasts).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.textContent).toBe('');

  window.weqRemoteConnection = { state: 'network' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  const warning = useToast.getState().toasts[0]!;
  expect(warning.title).toBe('网络已断开，恢复后自动重连');
  expect(warning.ttl).toBe(0);
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  expect(useToast.getState().toasts).toHaveLength(1);

  window.weqRemoteConnection = { state: 'connection' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  expect(useToast.getState().toasts[0]?.tone).toBe('warning');
  expect(useToast.getState().toasts[0]?.id).toBe(warning.id);
  // 网页 WebSocket 恢复不能覆盖原生尚未成功的鉴权验证。
  await act(async () => useWebConnection.getState().connected());
  expect(useToast.getState().toasts[0]?.tone).toBe('warning');

  window.weqRemoteConnection = { state: 'connected' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  expect(useToast.getState().toasts).toHaveLength(1);
  expect(useToast.getState().toasts[0]).toMatchObject({
    id: warning.id,
    tone: 'success',
    title: '连接已恢复',
  });
  expect(useToast.getState().toasts[0]?.ttl).toBeGreaterThan(0);
});

it('补读早到的壳状态并忽略无效状态', async () => {
  window.weqRemoteConnection = { state: 'connection' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(useToast.getState().toasts[0]?.tone).toBe('warning');
  Object.assign(window.weqRemoteConnection, { state: 'unexpected' });
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  expect(useToast.getState().toasts[0]?.tone).toBe('warning');
});

it('切换入口后的新网页补读恢复回执，不需要先重新显示断连横幅', async () => {
  window.weqRemoteConnection = { state: 'connected', recovery: 1 };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(useToast.getState().toasts[0]).toMatchObject({ tone: 'success', title: '连接已恢复' });
  const revision = useToast.getState().toasts[0]?.timerRevision;
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  expect(useToast.getState().toasts[0]?.timerRevision).toBe(revision);
});

it('Android 壳接口晚于初始状态就绪时仍补报已有的实时断连', async () => {
  window.weqRemoteConnection = { state: 'connected' };
  await act(async () => window.dispatchEvent(new Event('weq-remote-connection')));
  const connectionFailed = vi.fn();
  window.weqRemoteShell = { openMenu: vi.fn(), connectionFailed };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(connectionFailed).toHaveBeenCalledOnce();
});
