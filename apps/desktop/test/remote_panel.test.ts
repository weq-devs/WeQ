import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemotePanel,
  type RemoteStatus,
} from '../src/renderer/src/components/settings/RemotePanel';

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
        createElement(RemotePanel, {
          data,
          qr: null,
          busy: false,
          error: null,
          onToggle: noop,
          onLogin: noop,
          onInvite: noop,
          onDecide: noop,
          onRevoke: noop,
          ...extra,
        }),
      ),
    );
  }

  it('未安装辅助程序时不能开启，离线时不能生成配对码', async () => {
    await render({
      ...base,
      helperInstalled: false,
      enabled: false,
      network: { state: 'offline' },
    });
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('生成配对码'))
        ?.disabled,
    ).toBe(true);
  });

  it('待批准请求显示校验码，确认与撤销使用设备 ID', async () => {
    const onDecide = vi.fn();
    const onRevoke = vi.fn();
    await render(
      {
        ...base,
        pending: [{ id: 'claim', name: '测试手机', code: '123456', expiresAt: Date.now() + 10000 }],
      },
      { onDecide },
    );
    expect(container.textContent).toContain('123456');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('允许配对'))
        ?.click(),
    );
    expect(onDecide).toHaveBeenCalledWith('claim', true);
    await render(
      { ...base, devices: [{ id: 'device', name: '测试手机', approvedAt: 1, lastSeenAt: null }] },
      { onRevoke },
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="撤销 测试手机"]')?.click(),
    );
    expect(onRevoke).toHaveBeenCalledWith('device');
  });

  it('过期和已消费的二维码不再展示', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const qr = { qr: 'data:image/png;base64,fixture', expiresAt: 3000 };
    await render({ ...base, invitationExpiresAt: 3000 }, { qr });
    expect(container.querySelector('img')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('配对码已失效');
    await render(base, { qr });
    expect(container.querySelector('img')).toBeNull();
  });

  it('只有有效邀请才展示复制配对链接入口', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const onCopy = vi.fn();
    const qr = {
      qr: 'data:image/png;base64,fixture',
      expiresAt: 3000,
      pairingURL: 'weq-remote://pair?fixture=ui-only',
    };
    await render({ ...base, invitationExpiresAt: 3000 }, { qr, onCopy });
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('复制配对链接'),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(onCopy).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).not.toContain('复制配对链接');
  });

  it('Key 默认不选，勾选后点击生成才弹窗；校验后提交并清空', async () => {
    const onInvite = vi.fn();
    await render(
      {
        ...base,
        tailscaleEnabled: true,
        network: { ...base.network, address: 'http://100.64.0.10:7691' },
      },
      { onInvite },
    );
    expect(document.querySelector('#weq-remote-auth-key')).toBeNull();
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    const generate = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('生成配对码'))!;
    await act(async () => checkbox.click());
    await act(async () => {
      generate().focus();
      generate().click();
    });
    expect(onInvite).not.toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>('#weq-remote-auth-key');
    expect(input?.type).toBe('password');
    const authKey = `tskey-auth-${'k'.repeat(40)}`;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        authKey,
      );
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('.weq-remote-key-form button[type="submit"]')!
        .click(),
    );
    expect(onInvite).toHaveBeenCalledWith({ authKey });
    expect(document.querySelector('#weq-remote-auth-key')).toBeNull();
    expect(document.activeElement).toBe(generate());
    await act(async () => generate().click());
    expect(document.querySelector<HTMLInputElement>('#weq-remote-auth-key')?.value).toBe('');
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-remote-key-form button')]
        .find((button) => button.textContent === '取消')!
        .click(),
    );
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#weq-remote-auth-key')).toBeNull();
  });

  it('局域网直接生成配对码，不出现模式或地址选择器', async () => {
    const onInvite = vi.fn(),
      onTailscale = vi.fn();
    await render({ ...base, mode: 'lan' }, { onInvite, onTailscale });
    expect(container.querySelector('#weq-remote-auth-key')).toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('生成配对码'))
        ?.click(),
    );
    expect(onInvite).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('[aria-label="连接方式"]')).toBeNull();
    expect(container.querySelector('[aria-label="手机上的 Tailscale"]')).toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('启动服务'))
        ?.click(),
    );
    expect(onTailscale).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain('内网穿透');
    expect(container.textContent).toContain('App 已内置 Tailscale');
    expect(container.textContent).toContain('Key 加入电脑所在的 Tailscale 网络');
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
    expect(container.textContent).toContain('100.64.0.10');
    expect(container.textContent).toContain('192.168.1.8');
    expect(container.textContent).not.toContain('100.64.0.99');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('停止服务'))
        ?.click(),
    );
    expect(onTailscale).toHaveBeenCalledWith(false);
  });

  it('仅局域网就绪时可普通配对，勾选 Key 则等待专用 Tailscale 就绪', async () => {
    await render({
      ...base,
      tailscaleEnabled: true,
      network: { state: 'online', addresses: ['https://192.168.1.8:7691'] },
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(container.textContent).toContain('请先启动并登录');
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('生成配对码'))
        ?.disabled,
    ).toBe(true);
  });

  it('专用节点失败后可直接重新启动，Remote 关闭时不能更换节点身份', async () => {
    const onTailscale = vi.fn();
    await render(
      {
        ...base,
        tailscaleEnabled: true,
        network: { state: 'error', addresses: base.network.addresses },
      },
      { onTailscale },
    );
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('启动服务'),
    )!;
    await act(async () => start.click());
    expect(onTailscale).toHaveBeenCalledWith(true);
    await render({
      ...base,
      enabled: false,
      tailscaleEnabled: true,
      network: { state: 'offline' },
    });
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="更换 WeQ 专用 Tailscale 网络"]')
        ?.disabled,
    ).toBe(true);
  });
});
