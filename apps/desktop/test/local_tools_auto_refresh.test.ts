// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginAccountPanel } from '../src/renderer/src/components/LoginAccountPanel';
import { WonderfulToolsDialog } from '../src/renderer/src/components/WonderfulToolsDialog';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const rpc = vi.hoisted(() => ({ overview: vi.fn(), login: vi.fn(), scan: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { getSettings: { query: async () => ({ autoAttachQq: false }) } },
    wonderfulTools: {
      overview: { query: rpc.overview },
      loginAccountsOverview: { query: rpc.login },
      scanKey: { query: rpc.scan },
    },
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => ({ push() {} }) }));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/WorkspacePages', () => ({
  WorkspacePage: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/CapturePanel', () => ({ CapturePanel: () => null }));
vi.mock('../src/renderer/src/components/ReverseTool', () => ({ ReverseTool: () => null }));
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rpc.overview
    .mockReset()
    .mockResolvedValue([
      { uin: '10001', uid: 'u_fixture', userName: '合成账号', pid: 1, dataDir: null, dbPath: null },
    ]);
  rpc.login.mockReset().mockResolvedValue({
    accounts: [],
    guid: null,
    qqInstanceCount: 0,
    canWrite: true,
    supported: true,
    dataRoot: null,
  });
  rpc.scan.mockReset();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(content: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  const render = () => act(async () => root.render(h(TabActivity, { active }, content)));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  await render();
  return {
    host,
    setActive: async (value: boolean) => {
      active = value;
      await render();
    },
  };
}

it('密钥工具只自动读取账号概况，隐藏不继续读取，恢复不发起扫描', async () => {
  const view = await mount(
    h(WonderfulToolsDialog, {
      open: true,
      initialTool: 'key-scan',
      tools: ['key-scan'],
      onClose() {},
    }),
  );
  expect(rpc.overview).toHaveBeenCalledTimes(1);
  expect(view.host.textContent).toContain('合成账号');
  await view.setActive(false);
  expect(rpc.overview).toHaveBeenCalledTimes(1);
  await view.setActive(true);
  expect(rpc.overview).toHaveBeenCalledTimes(2);
  expect(rpc.scan).not.toHaveBeenCalled();
});

it('本地登录账号管理在断网时仍可读取，恢复仅更新列表', async () => {
  const view = await mount(h(LoginAccountPanel));
  expect(rpc.login).toHaveBeenCalledTimes(1);
  await view.setActive(false);
  await view.setActive(true);
  expect(rpc.login).toHaveBeenCalledTimes(2);
  expect(view.host.textContent).not.toContain('刷新');
  expect(rpc.scan).not.toHaveBeenCalled();
});
