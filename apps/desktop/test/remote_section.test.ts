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
  remoteRunning: false,
  webToken: vi.fn(),
  refreshWeb: vi.fn(),
  refreshRemote: vi.fn(),
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
            refetch: f.refreshRemote,
            data: {
              available: true,
              helperInstalled: true,
              enabled: f.remoteRunning,
              network: { state: 'offline' },
              pending: [],
              devices: [],
              invitationExpiresAt: null,
            },
          }),
        },
        webStatus: {
          useQuery: () => ({
            refetch: f.refreshWeb,
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
        setTailscaleEnabled: mutation(),
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
  f.remoteRunning = false;
  vi.clearAllMocks();
  f.enabled.mockReset();
  f.webEnabled.mockReset();
  f.autoStart.mockReset();
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
it('仅开启远程连接，不启动本机浏览器入口、不修改偏好或弹联动确认', async () => {
  await enable();
  expect(f.enabled).toHaveBeenCalledWith({ enabled: true });
  expect(useDialog.getState().current).toBeNull();
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.autoStart).not.toHaveBeenCalled();
});
it('本机浏览器已开启时，开启 Remote 仍不修改本机入口和偏好', async () => {
  f.remembered = true;
  f.webRunning = true;
  await enable();
  expect(useDialog.getState().current).toBeNull();
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.autoStart).not.toHaveBeenCalled();
});

it('本机自动启动已记住但当前关闭时，Remote 不改变当前本机访问状态', async () => {
  f.remembered = true;
  await enable();
  expect(useDialog.getState().current).toBeNull();
  expect(f.webEnabled).not.toHaveBeenCalled();
});

it('Remote 运行时关闭本机浏览器入口，不关闭 Remote 或弹确认', async () => {
  f.remoteRunning = true;
  f.webRunning = true;
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="允许本机浏览器访问"]')!.click(),
  );
  expect(useDialog.getState().current).toBeNull();
  expect(f.webEnabled).toHaveBeenCalledWith({ enabled: false });
  expect(f.enabled).not.toHaveBeenCalled();
});

it('Remote 运行时取消本机自动启动，不关闭任何入口或弹确认', async () => {
  f.remoteRunning = true;
  f.remembered = true;
  f.webRunning = true;
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="启动 WeQ 时自动允许本机浏览器访问"]')!
      .click(),
  );
  expect(useDialog.getState().current).toBeNull();
  expect(f.autoStart).toHaveBeenCalledWith({ enabled: false });
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.enabled).not.toHaveBeenCalled();
});

it('关闭 Remote 不关闭本机浏览器入口或修改自动启动偏好', async () => {
  f.remoteRunning = true;
  f.webRunning = true;
  f.remembered = true;
  await enable();
  expect(f.enabled).toHaveBeenCalledWith({ enabled: false });
  expect(f.webEnabled).not.toHaveBeenCalled();
  expect(f.autoStart).not.toHaveBeenCalled();
  expect(useDialog.getState().current).toBeNull();
});

it('Remote 启动仍在等待时，本机浏览器可独立操作且只刷新自身状态', async () => {
  let finish: (() => void) | undefined;
  f.enabled.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await enable();
  const local = container.querySelector<HTMLButtonElement>('[aria-label="允许本机浏览器访问"]')!;
  const remote = container.querySelector<HTMLButtonElement>('[aria-label="允许远程连接"]')!;
  expect(remote.disabled).toBe(true);
  expect(local.disabled).toBe(false);
  await act(async () => local.click());
  expect(f.webEnabled).toHaveBeenCalledWith({ enabled: true });
  expect(f.refreshWeb).toHaveBeenCalledOnce();
  expect(f.refreshRemote).not.toHaveBeenCalled();
  await act(async () => finish!());
  expect(f.refreshRemote).toHaveBeenCalledOnce();
  expect(f.refreshWeb).toHaveBeenCalledOnce();
});

it('本机浏览器操作仍在等待时，Remote 开关保持可用', async () => {
  let finish: (() => void) | undefined;
  f.webEnabled.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(createElement(RemoteSection)));
  const local = container.querySelector<HTMLButtonElement>('[aria-label="允许本机浏览器访问"]')!;
  const remote = container.querySelector<HTMLButtonElement>('[aria-label="允许远程连接"]')!;
  await act(async () => local.click());
  expect(local.disabled).toBe(true);
  expect(remote.disabled).toBe(false);
  await act(async () => remote.click());
  expect(f.enabled).toHaveBeenCalledWith({ enabled: true });
  expect(f.refreshRemote).toHaveBeenCalledOnce();
  expect(f.refreshWeb).not.toHaveBeenCalled();
  await act(async () => finish!());
});

it('本机入口失败只显示在本机区域，Remote 仍可操作且不会清除该错误', async () => {
  f.webEnabled.mockRejectedValueOnce(new Error('合成本机入口启动失败'));
  await act(async () => root.render(createElement(RemoteSection)));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="允许本机浏览器访问"]')!.click(),
  );
  expect(container.querySelector('.weq-remote-web [role="alert"]')?.textContent).toBe(
    '合成本机入口启动失败',
  );
  expect(container.querySelector('.weq-remote [role="alert"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="允许远程连接"]')!.click(),
  );
  expect(f.enabled).toHaveBeenCalledWith({ enabled: true });
  expect(container.querySelector('.weq-remote-web [role="alert"]')?.textContent).toBe(
    '合成本机入口启动失败',
  );
});

it('Remote 失败只显示在远程区域，本机入口仍可操作', async () => {
  f.enabled.mockRejectedValueOnce(new Error('合成 Remote 启动失败'));
  await enable();
  expect(container.querySelector('.weq-remote [role="alert"]')?.textContent).toBe(
    '合成 Remote 启动失败',
  );
  expect(container.querySelector('.weq-remote-web [role="alert"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="允许本机浏览器访问"]')!.click(),
  );
  expect(f.webEnabled).toHaveBeenCalledWith({ enabled: true });
  expect(container.querySelector('.weq-remote [role="alert"]')?.textContent).toBe(
    '合成 Remote 启动失败',
  );
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
