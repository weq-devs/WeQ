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
    network: { state: 'online' },
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

  it('内嵌 Tailscale 填写 Key 后即可生成二维码，没有额外确认', async () => {
    const onInvite = vi.fn();
    await render({ ...base, mode: 'tailscale' }, { onInvite });
    const input = container.querySelector<HTMLInputElement>('#weq-remote-auth-key');
    expect(input?.type).toBe('password');
    const generate = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('生成配对码'))!;
    expect(generate().disabled).toBe(true);
    const authKey = `tskey-auth-${'k'.repeat(40)}`;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        authKey,
      );
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(generate().disabled).toBe(false);
    await act(async () => generate().click());
    expect(onInvite).toHaveBeenCalledWith({ authKey });
    expect(input?.value).toBe('');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).toContain('不会撤销入网密钥');
  });

  it('局域网不需要登录或 Key，连接方式支持切换', async () => {
    const onInvite = vi.fn(),
      onMode = vi.fn();
    await render({ ...base, mode: 'lan' }, { onInvite, onMode });
    expect(container.querySelector('#weq-remote-auth-key')).toBeNull();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('生成配对码'))
        ?.click(),
    );
    expect(onInvite).toHaveBeenCalledWith(undefined);
    await act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Tailscale')?.click(),
    );
    expect(onMode).toHaveBeenCalledWith('tailscale');
  });

  it('已有 Tailscale 不需要 Key 或重新登录，只使用电脑的 Tailscale 地址', async () => {
    const onInvite = vi.fn(),
      onRefresh = vi.fn();
    await render(
      {
        ...base,
        mode: 'existing',
        network: {
          state: 'online',
          addresses: ['https://192.168.1.8:7691', 'https://100.64.0.10:7692'],
        },
      },
      { onInvite, onRefresh },
    );
    expect(container.querySelector('#weq-remote-auth-key')).toBeNull();
    expect(container.textContent).not.toContain('验证 Tailscale');
    expect(container.textContent).toContain('https://100.64.0.10:7692');
    expect(container.textContent).not.toContain('https://192.168.1.8:7691');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('生成配对码'))
        ?.click(),
    );
    expect(onInvite).toHaveBeenCalledWith(undefined);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="刷新连接地址"]')?.click(),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('已有 Tailscale 没有可用地址时不能错误生成局域网二维码', async () => {
    await render({
      ...base,
      mode: 'existing',
      network: { state: 'online', addresses: ['https://192.168.1.8:7691'] },
    });
    expect(container.textContent).toContain('未检测到 Tailscale 地址');
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('生成配对码'))
        ?.disabled,
    ).toBe(true);
  });

  it('顶层只有局域网与 Tailscale，手机已有/没有放在 Tailscale 内', async () => {
    const onMode = vi.fn();
    await render(
      {
        ...base,
        mode: 'existing',
        network: { state: 'online', addresses: ['https://100.64.0.10:7692'] },
      },
      { onMode },
    );
    const top = container.querySelector('[aria-label="连接方式"]')!;
    expect([...top.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(
      ['局域网', 'Tailscale'],
    );
    const phone = container.querySelector('[aria-label="手机上的 Tailscale"]')!;
    expect(phone.textContent).toContain('已有 Tailscale');
    expect(phone.textContent).toContain('没有 Tailscale');
    await act(async () =>
      [...phone.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('没有'))
        ?.click(),
    );
    expect(onMode).toHaveBeenCalledWith('tailscale');
    await render({ ...base, mode: 'lan' });
    expect(container.querySelector('[aria-label="手机上的 Tailscale"]')).toBeNull();
  });
});
