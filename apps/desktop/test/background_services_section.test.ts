import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundServicesSection } from '../src/renderer/src/components/settings/BackgroundServicesSection';
import { SettingsNavigateContext } from '../src/renderer/src/components/settings/controls';

/**
 * 「后台服务」汇总页只做只读展示 —— 这里验证六张卡片都在、状态文案按各服务的
 * 返回字段正确组合、失败时显示可重试的错误而不是冒充「已停止」。
 */

const fixture = vi.hoisted(() => ({
  mcp: {
    enabled: true,
    port: 48765,
    token: 't',
    url: 'http://127.0.0.1:48765',
    running: true,
    accountOpen: true,
  },
  onebot: {
    enabled: true,
    port: 48766,
    token: 't',
    url: 'ws://127.0.0.1:48766',
    running: false,
    clients: 0,
    accountOpen: true,
  },
  assistant: { enabled: true, port: 27182, url: 'http://127.0.0.1:27182', running: false },
  sse: { configured: true, pushUrl: 'https://push.example/sse', running: true, accountOpen: true },
  web: { enabled: true, url: 'http://127.0.0.1:7690', autoStart: false, available: true },
  remote: { enabled: false, available: true },
  settings: { windowCloseBehavior: 'tray' as 'ask' | 'tray' | 'quit' },
  errors: new Set<string>(),
  queries: [] as Array<{ path: string; enabled: boolean }>,
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

function result(path: string) {
  // trpc 路径形如 `bootstrap.getMcpStatus` / `remote.webStatus`，按后缀认。
  const tail = path.slice(path.lastIndexOf('.') + 1);
  const data =
    tail === 'getMcpStatus'
      ? fixture.mcp
      : tail === 'getOneBotStatus'
        ? fixture.onebot
        : tail === 'getWeqAssistantStatus'
          ? fixture.assistant
          : tail === 'getSsePushStatus'
            ? fixture.sse
            : tail === 'webStatus'
              ? fixture.web
              : tail === 'status'
                ? fixture.remote
                : fixture.settings;
  return {
    data: fixture.errors.has(tail) ? undefined : data,
    error: fixture.errors.has(tail) ? { message: `${tail} 读取失败` } : null,
    isLoading: false,
    isFetching: false,
    refetch: async () => ({ data }),
  };
}

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => {
        if (key === 'useQuery')
          return (_input: unknown, options?: { enabled?: boolean }) => {
            fixture.queries.push({ path, enabled: options?.enabled !== false });
            return result(path);
          };
        if (key === 'useMutation') return () => ({ mutateAsync: fixture.mutate, isLoading: false });
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/RetainedTabs', () => ({ useTabActive: () => true }));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (store: unknown) => unknown) =>
    select({ showError: vi.fn(), confirm: vi.fn() }),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.errors.clear();
  fixture.queries = [];
  fixture.settings = { windowCloseBehavior: 'tray' };
  fixture.mutate.mockReset().mockResolvedValue(true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(navigate?: (section: string) => void) {
  act(() => {
    root.render(
      createElement(
        SettingsNavigateContext.Provider,
        { value: navigate ?? null },
        createElement(BackgroundServicesSection),
      ),
    );
  });
}

describe('后台服务汇总页', () => {
  it('六个服务卡片都在', () => {
    render();
    const titles = [...host.querySelectorAll('.weq-set-card-title')].map((n) => n.textContent);
    expect(titles).toEqual([
      '关闭窗口时',
      'MCP 服务器',
      'OneBot 服务',
      'QQ 公众号推送',
      'WeQ Web 服务',
      'WeQ Remote',
      'SSE 消息推送',
    ]);
  });

  it('状态文案按各服务的返回字段组合', () => {
    render();
    const text = host.textContent ?? '';
    expect(text).toContain('运行中'); // MCP + SSE
    expect(text).toContain('已停止'); // Remote
    // OneBot 启用但没在监听 → 「已启用（未在监听）」。
    expect(text).toContain('已启用（未在监听）');
  });

  it('启用但账号未打开时显示等待账号', () => {
    fixture.onebot = { ...fixture.onebot, accountOpen: false };
    render();
    expect(host.textContent).toContain('已启用（等待账号）');
  });

  it('读取失败显示可重试的错误，不冒充已停止', () => {
    fixture.errors.add('getMcpStatus');
    render();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('getMcpStatus 读取失败');
    expect(alert?.querySelector('button')).not.toBeNull();
  });

  it('「管理」按钮跳到对应页面', () => {
    const navigate = vi.fn();
    render(navigate);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.weq-set-card-action button')];
    const target = buttons.find((button) =>
      button.closest('.weq-set-card')?.textContent?.includes('OneBot'),
    );
    act(() => target!.click());
    expect(navigate).toHaveBeenCalledWith('onebot');
  });

  it('关闭行为分段控件写回设置', async () => {
    render();
    const option = [...host.querySelectorAll<HTMLButtonElement>('.weq-set-seg-item')].find(
      (button) => button.textContent === '每次询问',
    );
    await act(async () => option!.click());
    expect(fixture.mutate).toHaveBeenCalledWith({ behavior: 'ask' });
  });
});
