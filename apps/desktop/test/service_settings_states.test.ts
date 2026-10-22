import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalRkeySection } from '../src/renderer/src/components/settings/ExternalRkeySection';
import { SsePushSection } from '../src/renderer/src/components/settings/SsePushSection';
import { McpServerSection } from '../src/renderer/src/components/settings/McpServerSection';

const api = vi.hoisted(() => ({
  mode: 'ready',
  retry: vi.fn(),
  mutate: vi.fn(),
  settings: {
    externalRkey: {
      servers: [
        {
          id: 'synthetic',
          name: '合成RKEY',
          baseUrl: 'https://example.invalid',
          accessToken: 'synthetic',
        },
      ],
      enabledServerId: null,
    },
    ssePush: {
      servers: [
        { id: 'synthetic', name: '合成SSE', pushUrl: 'https://example.invalid', accessToken: '' },
      ],
      enabledServerId: null,
      debounceMs: 2000,
      massThreshold: 50,
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const targets = [
    {
      key: 'synthetic',
      name: '合成客户端',
      configPath: '/synthetic',
      available: true,
      installed: false,
      upToDate: false,
    },
  ];
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useQuery')
          return () => ({
            data:
              api.mode === 'error' || api.mode === 'loading'
                ? undefined
                : path.endsWith('getSettings')
                  ? api.settings
                  : path.endsWith('getMcpStatus')
                    ? {
                        enabled: false,
                        running: false,
                        port: 48765,
                        token: 'synthetic',
                        url: 'http://127.0.0.1:48765',
                      }
                    : path.endsWith('listMcpAgentTargets')
                      ? targets
                      : '{}',
            error: ['error', 'stale'].includes(api.mode) ? Error('合成服务读取失败') : null,
            isLoading: api.mode === 'loading',
            isFetching: false,
            refetch: api.retry,
          });
        if (key === 'useMutation') return () => ({ isLoading: false, mutateAsync: api.mutate });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const components = { rkey: ExternalRkeySection, sse: SsePushSection, mcp: McpServerSection };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mode = 'ready';
  api.retry.mockClear();
  api.mutate.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render(kind: keyof typeof components) {
  act(() => root.render(createElement(components[kind])));
}
describe.each(['rkey', 'sse', 'mcp'] as const)('%s 服务设置读取状态', (kind) => {
  it('加载不冒充空服务或已停止', () => {
    api.mode = 'loading';
    render(kind);
    expect(host.textContent).toContain('正在读取');
    expect(host.textContent).not.toContain('还没有');
    expect(host.textContent).not.toContain('已停止');
    if (kind === 'mcp')
      expect(
        host.querySelector('[aria-label="启用 MCP 服务器"]')!.getAttribute('aria-checked'),
      ).toBe('mixed');
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it('失败可重试，不生成默认状态或空列表结论', () => {
    api.mode = 'error';
    render(kind);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成服务读取失败');
    expect(host.textContent).not.toContain('还没有');
    expect(host.textContent).not.toContain('没找到本机');
    expect(host.textContent).not.toContain('已停止');
    act(() => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(api.retry).toHaveBeenCalledOnce();
    if (kind === 'mcp')
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="启用 MCP 服务器"]')!.disabled,
      ).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
    api.mode = 'ready';
    render(kind);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('读取失败保留已有配置并显式提示', () => {
    api.mode = 'stale';
    render(kind);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      host.querySelectorAll(kind === 'mcp' ? '.weq-set-agent-item' : '.weq-set-server-item'),
    ).toHaveLength(1);
  });
});
it('SSE 同值重新读取不覆盖正在编辑的调优值', () => {
  render('sse');
  act(() => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '3500');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  api.settings = { ...api.settings, ssePush: { ...api.settings.ssePush } };
  render('sse');
  expect(host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!.value).toBe('3500');
  expect(api.mutate).not.toHaveBeenCalled();
  api.settings = { ...api.settings, ssePush: { ...api.settings.ssePush, massThreshold: 75 } };
  render('sse');
  expect(host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!.value).toBe('3500');
  expect(host.querySelector<HTMLInputElement>('[aria-label="大量消息阈值"]')!.value).toBe('75');
});
