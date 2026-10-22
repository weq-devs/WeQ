import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteSection } from '../src/renderer/src/components/settings/RemoteSection';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { useToast } from '../src/renderer/src/components/Toast';

const f = vi.hoisted(() => ({
  enabled: vi.fn(),
  webEnabled: vi.fn(),
  autoStart: vi.fn(),
  remembered: false,
  webRunning: false,
  webToken: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const mutation = (mutateAsync = vi.fn()) => ({
    useMutation: () => ({ isLoading: false, mutateAsync }),
  });
  return {
    client: { remote: { webToken: { mutate: f.webToken } } },
    trpc: {
      remote: {
        status: {
          useQuery: () => ({
            isLoading: false,
            refetch: vi.fn(),
            data: {
              available: true,
              helperInstalled: true,
              enabled: false,
              network: { state: 'offline' },
              pending: [],
              devices: [],
              invitationExpiresAt: null,
            },
          }),
        },
        webStatus: {
          useQuery: () => ({
            refetch: vi.fn(),
            data: {
              available: true,
              assetsInstalled: true,
              enabled: f.webRunning,
              autoStart: f.remembered,
              url: f.webRunning ? 'http://127.0.0.1:7690' : null,
            },
          }),
        },
        setEnabled: mutation(f.enabled),
        setWebEnabled: mutation(f.webEnabled),
        setWebAutoStart: mutation(f.autoStart),
        openLogin: mutation(),
        setMode: mutation(),
        changeNetwork: mutation(),
        refreshNetwork: mutation(),
        decide: mutation(),
        revoke: mutation(),
      },
    },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
const originalToastPush = useToast.getState().push;
beforeEach(async () => {
  f.remembered = false;
  f.webRunning = false;
  vi.clearAllMocks();
  f.webToken.mockResolvedValue('synthetic-web-access-token');
  useDialog.getState().close();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  useDialog.getState().close();
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  useToast.setState({ toasts: [], push: originalToastPush });
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});

async function enable() {
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="允许远程连接"]')!.click(),
  );
}
it('开启远程连接时推荐 Web 自动启动，用户同意后才启动并保存', async () => {
  await enable();
  expect(f.enabled).toHaveBeenCalledWith({ enabled: true });
  const dialog = useDialog.getState().current!;
  expect(dialog.message).toContain('自动开启 Web 服务');
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.autoStart).not.toHaveBeenCalled();
  await act(async () => dialog.confirm!.resolve(true));
  expect(f.webEnabled).toHaveBeenCalledWith({ enabled: true });
  expect(f.autoStart).toHaveBeenCalledWith({ enabled: true });
});
it('暂不开启不改偏好，已经开启自动启动时不重复推荐', async () => {
  await enable();
  await act(async () => useDialog.getState().current!.confirm!.resolve(false));
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.autoStart).not.toHaveBeenCalled();
  useDialog.getState().close();
  f.remembered = true;
  await enable();
  expect(useDialog.getState().current).toBeNull();
});

it('访问令牌复制成功后提供明确反馈，不显示令牌内容', async () => {
  f.webRunning = true;
  const write = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue();
  const toast = vi.spyOn(useToast.getState(), 'push');
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('复制访问令牌'))!
      .click(),
  );
  expect(f.webToken).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith('synthetic-web-access-token');
  expect(container.textContent).toContain('已复制令牌');
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ tone: 'success', title: '访问令牌已复制' }),
  );
  expect(container.textContent).not.toContain('synthetic-web-access-token');
});

it('浏览器剪贴板不可用时复用已有回退复制能力', async () => {
  f.webRunning = true;
  const write = vi
    .spyOn(window.navigator.clipboard, 'writeText')
    .mockRejectedValue(new Error('NotAllowedError'));
  const exec = vi.fn((command: string) => {
    expect(command).toBe('copy');
    expect(document.querySelector('textarea')?.value).toBe('synthetic-web-access-token');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('复制访问令牌'))!
      .click(),
  );
  expect(exec).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  expect(container.textContent).toContain('已复制令牌');
  expect(document.querySelector('textarea')).toBeNull();
});

it('复制被拒绝时在 Web 区域显示失败并允许重试，不假报成功', async () => {
  f.webRunning = true;
  vi.spyOn(window.navigator.clipboard, 'writeText').mockRejectedValue(new Error('NotAllowedError'));
  const toast = vi.spyOn(useToast.getState(), 'push');
  await act(async () => root.render(createElement(RemoteSection)));
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('复制访问令牌'),
  )!;
  await act(async () => button.click());
  expect(container.querySelector('.weq-remote-web [role="alert"]')?.textContent).toContain(
    '复制失败',
  );
  expect(button.disabled).toBe(false);
  expect(container.textContent).not.toContain('已复制令牌');
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', title: '复制失败' }));
});

it('读取令牌失败不写剪贴板，重试成功后清除旧错误', async () => {
  f.webRunning = true;
  f.webToken.mockRejectedValueOnce(new Error('service unavailable'));
  const write = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue();
  await act(async () => root.render(createElement(RemoteSection)));
  const button = container.querySelector<HTMLButtonElement>('.weq-remote-copy-token')!;
  await act(async () => button.click());
  expect(write).not.toHaveBeenCalled();
  expect(container.querySelector('.weq-remote-web [role="alert"]')).not.toBeNull();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(write).toHaveBeenCalledWith('synthetic-web-access-token');
  expect(container.querySelector('.weq-remote-web [role="alert"]')).toBeNull();
  expect(button.textContent).toContain('已复制令牌');
});
