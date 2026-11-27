import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogHost } from '../src/renderer/src/components/Dialog';
import {
  RemotePanel,
  type RemoteStatus,
} from '../src/renderer/src/components/settings/RemotePanel';
import { REMOTE_ACTIVITY_WINDOW } from '../src/shared/remote_device';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('电脑端远程连接面板', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const noop = () => {};
  const base: RemoteStatus = {
    available: true,
    helperInstalled: true,
    enabled: true,
    network: { state: 'online', addresses: ['https://192.168.1.8:7691'] },
    invitationExpiresAt: null,
    pending: [],
    devices: [],
  };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  async function render(data: RemoteStatus, extra = {}) {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(RemotePanel, {
            data,
            busy: false,
            error: null,
            onToggle: noop,
            onLogin: noop,
            onInvite: async () => undefined,
            onReview: noop,
            onRevoke: noop,
            ...extra,
          }),
          createElement(DialogHost),
        ),
      ),
    );
  }

  const dialog = () =>
    document.querySelector<HTMLElement>('[aria-labelledby="weq-remote-pair-title"]');
  function button(label: string, root: ParentNode = container) {
    return [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  }
  async function openPairing(cross = false) {
    await act(async () => button('配对设备').click());
    if (cross)
      await act(async () =>
        dialog()!
          .querySelector<HTMLInputElement>('[aria-labelledby="weq-remote-route-tailscale"]')!
          .click(),
      );
  }
  const qr = {
    qr: 'data:image/png;base64,fixture',
    expiresAt: 3000,
    pairingURL: 'weq-remote://pair?fixture=ui-only',
  };

  it('未安装辅助程序时不能开启，离线时不能生成配对码', async () => {
    await render({
      ...base,
      helperInstalled: false,
      enabled: false,
      network: { state: 'offline' },
    });
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    expect(button('配对设备').disabled).toBe(true);
  });

  it('待批准请求显示校验码，查看请求使用设备 ID', async () => {
    const onReview = vi.fn();
    await render(
      {
        ...base,
        pending: [{ id: 'claim', name: '测试手机', code: '123456', expiresAt: Date.now() + 10000 }],
      },
      { onReview },
    );
    expect(container.textContent).toContain('123456');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('查看请求'))
        ?.click(),
    );
    expect(onReview).toHaveBeenCalledWith('claim');
  });

  it('删除已配对手机需确认，取消保留设备，确认后撤销指定设备', async () => {
    const onRevoke = vi.fn();
    await render(
      { ...base, devices: [{ id: 'device', name: '测试手机', approvedAt: 1, lastSeenAt: null }] },
      { onRevoke },
    );
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="删除 测试手机"]')!;
    const confirmation = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const button = (label: string) =>
      [...confirmation().querySelectorAll('button')].find((item) => item.textContent === label)!;

    await act(async () => remove.click());
    expect(confirmation().textContent).toContain('测试手机');
    expect(onRevoke).not.toHaveBeenCalled();
    await act(async () => button('取消').click());
    expect(onRevoke).not.toHaveBeenCalled();
    await act(async () => remove.click());
    await act(async () => button('删除设备').click());
    expect(onRevoke).toHaveBeenCalledOnce();
    expect(onRevoke).toHaveBeenCalledWith('device');
  });

  it('过期或已消费的二维码停止显示和复制', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const onInvite = vi.fn(async () => qr);
    const onCopy = vi.fn();
    const props = { onInvite, onCopy };
    await render({ ...base, invitationExpiresAt: qr.expiresAt }, props);
    await openPairing();
    await act(async () => button('生成配对码', dialog()!).click());
    expect(dialog()!.querySelector('img')).not.toBeNull();
    await act(async () => button('复制配对链接', dialog()!).click());
    expect(onCopy).toHaveBeenCalledWith(qr.pairingURL);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(dialog()!.querySelector('img')).toBeNull();
    expect(button('复制配对链接', dialog()!)).toBeUndefined();
    await act(async () => button('返回连接方式', dialog()!).click());
    vi.setSystemTime(1000);
    await act(async () => button('生成配对码', dialog()!).click());
    await render(
      {
        ...base,
        pending: [{ id: 'claim', name: '测试设备', code: '123456', expiresAt: 3000 }],
      },
      props,
    );
    expect(dialog()!.querySelector('img')).toBeNull();
    await act(async () => button('返回设置确认', dialog()!).click());
    expect(button('查看请求')).toBeDefined();
  });

  it('展示配对与最近访问时间、完整设备资料，活跃状态自动过期并兼容旧设备', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-13T04:00:00Z');
    vi.setSystemTime(now);
    const device = {
      id: 'device-detail',
      name: '测试手机',
      approvedAt: now - 86_400_000,
      lastSeenAt: now,
      scope: 'web:access',
      deviceInfo: {
        platform: 'ios' as const,
        model: 'iPhone17,1',
        osVersion: '26.1',
        appVersion: '1.0.0b3',
        appBuild: '11',
      },
      lastConnection: { ip: '100.64.0.7', route: 'tailscale' as const },
    };
    await render({ ...base, devices: [device] });
    expect(container.textContent).toContain('近期活跃');
    expect(container.textContent).toContain('2026-11-12 12:00:00');
    expect(container.textContent).toContain('刚刚');
    const details = container.querySelector<HTMLDetailsElement>('.weq-remote-device details')!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector('summary')?.click());
    expect(details.open).toBe(true);
    for (const value of [
      'iPhone17,1',
      '26.1',
      '1.0.0b3 (11)',
      '100.64.0.7',
      'Tailscale',
      'device-detail',
    ])
      expect(details.textContent).toContain(value);
    await act(async () => vi.advanceTimersByTime(REMOTE_ACTIVITY_WINDOW + 1000));
    expect(container.textContent).toContain('未活跃');
    expect(container.textContent).not.toContain('近期活跃');
    await render({
      ...base,
      devices: [{ id: 'old', name: '旧手机', approvedAt: 1, lastSeenAt: null }],
    });
    expect(container.textContent).toContain('尚未访问');
    expect(container.textContent).toContain('未上报');
    expect(container.textContent).toContain('暂无记录');
    await render({ ...base, enabled: false, devices: [device] });
    expect(container.textContent).toContain('服务已关闭');
  });

  it('局域网是默认路径，电脑未启动 Tailscale 时也能生成码', async () => {
    const onInvite = vi.fn(async () => undefined);
    await render(base, { onInvite });
    await openPairing();
    expect(dialog()!.querySelector('#weq-remote-auth-key')).toBeNull();
    await act(async () => button('生成配对码', dialog()!).click());
    expect(onInvite).toHaveBeenCalledWith({ mode: 'lan' });
  });

  it('在跨网配对中启动、登录并继续入网，关闭后清空密钥', async () => {
    const onInvite = vi.fn(async () => qr);
    const onTailscale = vi.fn();
    const onLogin = vi.fn();
    const props = { onInvite, onTailscale, onLogin };
    await render(base, props);
    await openPairing(true);
    expect(button('生成配对码', dialog()!).disabled).toBe(true);
    await act(async () => button('启动 Tailscale', dialog()!).click());
    expect(onTailscale).toHaveBeenCalledWith(true);
    const starting = { ...base, tailscaleEnabled: true };
    await render({ ...starting, network: { ...base.network, state: 'starting' } }, props);
    expect(dialog()!.querySelector('#weq-remote-auth-key')).toBeNull();
    await render({ ...starting, network: { ...base.network, state: 'login' } }, props);
    expect(button('登录 Tailscale', dialog()!).disabled).toBe(true);
    await render(
      {
        ...starting,
        network: { ...base.network, state: 'login', authUrl: 'https://login.example.test' },
      },
      props,
    );
    await act(async () => button('登录 Tailscale', dialog()!).click());
    expect(onLogin).toHaveBeenCalledOnce();
    const online = {
      ...starting,
      network: { ...base.network, address: 'http://100.64.0.10:7691' },
      invitationExpiresAt: qr.expiresAt,
    };
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await render(online, props);
    const input = dialog()!.querySelector<HTMLInputElement>('#weq-remote-auth-key')!;
    expect(input.type).toBe('password');
    const authKey = `tskey-auth-${'k'.repeat(40)}`;
    const fillKey = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await fillKey('bad-key');
    await act(async () => button('生成配对码', dialog()!).click());
    expect(onInvite).not.toHaveBeenCalled();
    await fillKey(authKey);
    await act(async () => button('生成配对码', dialog()!).click());
    expect(onInvite).toHaveBeenCalledWith({ mode: 'tailscale', authKey });
    expect(dialog()!.querySelector('img')).not.toBeNull();
    await act(async () => button('关闭', dialog()!).click());
    expect(document.activeElement).toBe(button('配对设备'));
    await openPairing(true);
    expect(dialog()!.querySelector<HTMLInputElement>('#weq-remote-auth-key')?.value).toBe('');
    await act(async () =>
      dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(dialog()!.querySelector('#weq-remote-auth-key')).toBeNull();
    await act(async () => button('生成配对码', dialog()!).click());
    expect(onInvite).toHaveBeenLastCalledWith({ mode: 'existing' });
  });

  it('并列展示局域网和 WeQ 专用节点，不采用系统 Tailscale 的地址', async () => {
    const onTailscale = vi.fn();
    await render(
      {
        ...base,
        tailscaleEnabled: true,
        network: {
          state: 'online',
          address: 'http://100.64.0.10:7691',
          addresses: ['https://192.168.1.8:7691', 'https://100.64.0.99:7691'],
        },
      },
      { onTailscale },
    );
    expect(container.querySelector('#weq-remote-auth-key')).toBeNull();
    await act(async () => container.querySelector('summary')!.click());
    expect(container.textContent).toContain('100.64.0.10');
    expect(container.textContent).toContain('192.168.1.8');
    expect(container.textContent).not.toContain('100.64.0.99');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('停止 Tailscale'))
        ?.click(),
    );
    expect(onTailscale).toHaveBeenCalledWith(false);
  });

  it('专用节点失败后可直接重新启动，Remote 关闭时不能更换节点身份', async () => {
    const onTailscale = vi.fn();
    const onChangeNetwork = vi.fn();
    await render(
      {
        ...base,
        tailscaleEnabled: true,
        network: { state: 'error', addresses: base.network.addresses },
      },
      { onTailscale, onChangeNetwork },
    );
    await act(async () => button('启动 Tailscale').click());
    expect(onTailscale).toHaveBeenCalledWith(true);
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => button('更换 Tailscale 网络').click());
    const confirm = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => button('取消', confirm()).click());
    expect(onChangeNetwork).not.toHaveBeenCalled();
    await act(async () => button('更换 Tailscale 网络').click());
    await act(async () => button('更换网络', confirm()).click());
    expect(onChangeNetwork).toHaveBeenCalledOnce();
    await render({
      ...base,
      enabled: false,
      tailscaleEnabled: true,
      network: { state: 'offline' },
    });
    expect(button('更换 Tailscale 网络')).toBeUndefined();
  });
});
