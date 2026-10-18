import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectScreen } from '../src/renderer/src/views/bootstrap/SelectScreen';
import type { GlobalInstallInfo } from '@weq/service';

const fixture = vi.hoisted(() => ({ mode: 'new', mac: true, login: vi.fn(), noop: vi.fn() }));
vi.mock('../src/renderer/src/views/bootstrap/LoginPanel', () => ({
  LoginPanel: (props: unknown) => {
    fixture.login(props);
    return null;
  },
}));
vi.mock('../src/renderer/src/views/bootstrap/StatsPanel', () => ({ StatsPanel: () => null }));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_MAC() {
    return fixture.mac;
  },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (read: (value: unknown) => unknown) =>
    read({
      selectMode: fixture.mode,
      backHome: fixture.noop,
      goTo: fixture.noop,
      setOpenedUin: fixture.noop,
    }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (read: (value: unknown) => unknown) => read({ showError: fixture.noop }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {},
  trpc: {
    useUtils: () => ({}),
    bootstrap: {
      listAccountConfigs: { useQuery: () => ({ data: [], isLoading: false }) },
      listAccounts: { useQuery: () => ({ data: [], isLoading: false }) },
      countUserDataDirs: { useQuery: () => ({ data: 0 }) },
      getAutoEnter: { useQuery: () => ({ data: null }) },
      probeOnline: { useQuery: () => ({ data: { count: 0 } }) },
    },
  },
}));
let close = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mode = 'new';
  fixture.mac = true;
  vi.clearAllMocks();
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});
function render() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() =>
    root.render(h(SelectScreen, { install: { tencentFilesRoot: null } as GlobalInstallInfo })),
  );
  return host;
}
describe('没有原 QQ 数据的托管首登', () => {
  it('macOS 新的开始即使没有历史账号，也显示登录来源入口', () => {
    render();
    expect(fixture.login).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'new', accounts: [], selected: null }),
    );
  });
  it('空的现有配置列表仍保持空状态，不擅自启动托管', () => {
    fixture.mode = 'existing';
    const host = render();
    expect(fixture.login).not.toHaveBeenCalled();
    expect(host.textContent).toContain('暂无保存的账号配置');
  });
});
