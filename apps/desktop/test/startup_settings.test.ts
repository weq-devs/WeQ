import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupSection } from '../src/renderer/src/components/settings/StartupSection';
import { useToast } from '../src/renderer/src/components/Toast';

const fixture = vi.hoisted(() => ({
  data: {
    supported: true,
    enabled: false,
    registered: false,
    requiresApproval: false,
    migrationError: undefined as string | undefined,
  },
  loading: false,
  pending: false,
  error: null as Error | null,
  paths: [] as string[],
  update: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => {
            fixture.paths.push(path);
            return {
              data: fixture.data,
              isLoading: fixture.loading,
              error: fixture.error,
              refetch: vi.fn(),
            };
          };
        if (key === 'useMutation')
          return () => {
            fixture.paths.push(path);
            return { isLoading: fixture.pending, mutateAsync: fixture.update };
          };
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy() };
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.data = {
    supported: true,
    enabled: false,
    registered: false,
    requiresApproval: false,
    migrationError: undefined,
  };
  fixture.loading = false;
  fixture.pending = false;
  fixture.error = null;
  fixture.paths = [];
  fixture.update.mockReset().mockResolvedValue(fixture.data);
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => vi.unstubAllGlobals());
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(StartupSection)));
  return {
    host,
    toggle: () => host.querySelector<HTMLButtonElement>('[role="switch"]')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
describe('独立系统自启设置', () => {
  it('只查询独立登录项，切换提交新接口，不读取 daemon 健康状态', async () => {
    const view = mount();
    try {
      expect(view.toggle().disabled).toBe(false);
      await act(async () => view.toggle().click());
      expect(fixture.update).toHaveBeenCalledWith({ enabled: true });
      expect(fixture.paths).toContain('bootstrap.getAutostartStatus');
      expect(fixture.paths.every((path) => !/daemon/i.test(path))).toBe(true);
      expect(view.host.textContent).not.toContain('守护进程');
    } finally {
      view.close();
    }
  });
  it.each(['loading', 'pending', 'unsupported', 'failed'] as const)(
    '%s 状态不能误提交',
    (state) => {
      fixture.loading = state === 'loading';
      fixture.pending = state === 'pending';
      fixture.data.supported = state !== 'unsupported';
      fixture.error = state === 'failed' ? new Error('合成读取失败') : null;
      const view = mount();
      try {
        expect(view.toggle().disabled).toBe(true);
        act(() => view.toggle().click());
        expect(fixture.update).not.toHaveBeenCalled();
      } finally {
        view.close();
      }
    },
  );
  it('待系统批准与旧后台迁移失败明确显示，不冒称自启已经生效', () => {
    fixture.data.requiresApproval = true;
    fixture.data.migrationError = '合成旧服务未停止';
    const view = mount();
    try {
      expect(view.host.textContent).toContain('需要系统批准');
      expect(view.host.textContent).toContain('旧后台迁移未完成');
      expect(view.host.textContent).not.toContain('已开启');
    } finally {
      view.close();
    }
  });
});
