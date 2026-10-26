import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LongTermAuthorizationSection } from '../src/renderer/src/components/settings/LongTermAuthorizationSection';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { LongTermAuthorizationLink } from '../src/renderer/src/components/LongTermAuthorizationLink';
import {
  onOpenSettingsRequest,
  requestOpenSettings,
} from '../src/renderer/src/lib/callSettingsBridge';
import type { LongTermAuthorizationStatus } from '../src/shared/long_term_authorization';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: false }));
const state = (value: LongTermAuthorizationStatus['state']): LongTermAuthorizationStatus => ({
  platform: 'darwin',
  state: value,
  message: `fixture ${value}`,
});
const bridge = { status: vi.fn(), install: vi.fn(), remove: vi.fn() };
let close = () => {};
let confirm = vi.fn();
beforeEach(() => {
  close = () => {};
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'weq', { configurable: true, value: { authorization: bridge } });
  bridge.status.mockReset().mockResolvedValue(state('not-installed'));
  bridge.install.mockReset().mockResolvedValue(state('ready'));
  bridge.remove.mockReset().mockResolvedValue(state('not-installed'));
  confirm = vi.fn().mockResolvedValue(true);
  useDialog.setState({ confirm });
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});
async function mount(element = createElement(LongTermAuthorizationSection)) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StrictMode, null, element)));
  return {
    host,
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((node) => node.textContent === label)!,
  };
}
describe('长期授权设置', () => {
  it('开发通道复用同一管理组件，并在提权确认中说明隔离范围', async () => {
    bridge.status.mockResolvedValue({ ...state('not-installed'), development: true });
    bridge.install.mockResolvedValue({ ...state('ready'), development: true });
    const view = await mount();
    expect(view.host.textContent).toContain('长期授权（开发）');
    await act(async () => view.button('启用长期授权').click());
    expect(confirm).toHaveBeenCalledWith(
      '启用或修复长期授权（开发）',
      expect.stringContaining('不替换或撤销正式助手'),
      expect.any(Object),
    );
    expect(bridge.install).toHaveBeenCalledWith(true);
  });
  it('打开、搜索或重新检查只读取状态，不自动安装', async () => {
    const view = await mount();
    expect(view.host.querySelector('[data-setting-id="long-term-authorization"]')).not.toBeNull();
    await act(async () => view.button('重新检查').click());
    expect(bridge.status).toHaveBeenCalledTimes(2);
    expect(bridge.install).not.toHaveBeenCalled();
    expect(bridge.remove).not.toHaveBeenCalled();
  });
  it('系统与页面确认成功后才启用，不因点击按钮提前报已连接', async () => {
    const view = await mount();
    let finish: (result: LongTermAuthorizationStatus) => void = () => {};
    bridge.install.mockReturnValue(
      new Promise<LongTermAuthorizationStatus>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => view.button('启用长期授权').click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(view.host.textContent).not.toContain('已连接');
    expect(view.button('正在授权…').disabled).toBe(true);
    await act(async () => finish(state('needs-repair')));
    expect(view.host.textContent).toContain('需要修复');
    expect(view.host.textContent).not.toContain('已连接');
  });
  it('取消确认不安装；系统拒绝保留错误和重试入口', async () => {
    const view = await mount();
    confirm.mockResolvedValueOnce(false);
    await act(async () => view.button('启用长期授权').click());
    expect(bridge.install).not.toHaveBeenCalled();
    bridge.install.mockRejectedValueOnce(new Error('fixture denied'));
    await act(async () => view.button('启用长期授权').click());
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('fixture denied');
    expect(view.button('启用长期授权').disabled).toBe(false);
  });
  it('已就绪支持修复与撤销；失败不误显示已撤销', async () => {
    bridge.status.mockResolvedValue(state('ready'));
    const view = await mount();
    expect(view.button('修复授权')).toBeDefined();
    bridge.remove.mockRejectedValueOnce(new Error('fixture remove denied'));
    await act(async () => view.button('撤销授权').click());
    expect(view.host.textContent).toContain('已连接');
    await act(async () => view.button('撤销授权').click());
    expect(view.host.textContent).toContain('未启用');
  });
  it('缺组件或无 systemd 时不提供假启用', async () => {
    bridge.status.mockResolvedValue(state('unavailable'));
    const view = await mount();
    expect(view.button('启用长期授权').disabled).toBe(true);
    expect(view.host.textContent).toContain('当前环境不可用');
  });
  it('同窗口跳转使用已有导航通道，重复点击仍可定位', () => {
    const navigate = vi.fn();
    const off = onOpenSettingsRequest(navigate);
    requestOpenSettings('longTermAuthorization');
    requestOpenSettings('longTermAuthorization');
    expect(navigate.mock.calls).toEqual([['longTermAuthorization'], ['longTermAuthorization']]);
    off();
    requestOpenSettings('longTermAuthorization');
    expect(navigate).toHaveBeenCalledTimes(2);
  });
  it('共享入口先结束当前提权界面再跳转，存储不可写也能导航', async () => {
    const events: string[] = [];
    const off = onOpenSettingsRequest((target) => events.push(target));
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('fixture denied');
    });
    try {
      const view = await mount(
        createElement(LongTermAuthorizationLink, { beforeNavigate: () => events.push('close') }),
      );
      await act(async () => view.button('管理长期授权').click());
      expect(events).toEqual(['close', 'longTermAuthorization']);
    } finally {
      off();
      storage.mockRestore();
    }
  });
});
