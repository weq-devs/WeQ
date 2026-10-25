import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantSection } from '../src/renderer/src/components/settings/AssistantSection';
import { StartupSection } from '../src/renderer/src/components/settings/StartupSection';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { useToast } from '../src/renderer/src/components/Toast';

const fixture = vi.hoisted(() => ({
  assistant: { enabled: false, port: 27182, running: false, url: 'http://127.0.0.1:27182' },
  startup: { supported: true, enabled: false, registered: false, requiresApproval: false },
  mutate: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const data = (path: string) =>
    path.endsWith('getWeqAssistantStatus') ? fixture.assistant : fixture.startup;
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data: data(path),
            isLoading: false,
            refetch: async () => ({ data: data(path) }),
          });
        if (key === 'useMutation')
          return () => ({
            isLoading: false,
            mutateAsync: (input: unknown) => fixture.mutate(path, input),
          });
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy() };
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.assistant = {
    enabled: false,
    port: 27182,
    running: false,
    url: 'http://127.0.0.1:27182',
  };
  fixture.startup = { supported: true, enabled: false, registered: false, requiresApproval: false };
  fixture.mutate
    .mockReset()
    .mockImplementation(async (path: string, input: { enabled: boolean }) => {
      if (path.endsWith('setWeqAssistantEnabled')) {
        fixture.assistant.enabled = input.enabled;
        return { ...fixture.assistant };
      }
      fixture.startup.enabled = input.enabled;
      return { ...fixture.startup };
    });
  useDialog.getState().close();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  useDialog.getState().close();
  vi.unstubAllGlobals();
});
function mount(component: typeof AssistantSection | typeof StartupSection, label: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(component)));
  return {
    click: async () =>
      act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()),
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
describe('助手与系统自启的双向提醒', () => {
  it.each([true, false])('启用助手后由用户选择是否同时开启自启：%s', async (agree) => {
    const view = mount(AssistantSection, '启用 WeQ 助手');
    try {
      await view.click();
      expect(fixture.assistant.enabled).toBe(true);
      const dialog = useDialog.getState().current;
      expect(dialog?.title).toContain('自启');
      expect(fixture.startup.enabled).toBe(false);
      await act(async () => dialog!.confirm!.resolve(agree));
      expect(fixture.startup.enabled).toBe(agree);
      expect(
        fixture.mutate.mock.calls.filter(([path]) => path === 'bootstrap.setAutostart'),
      ).toHaveLength(agree ? 1 : 0);
    } finally {
      view.close();
    }
  });
  it.each(['enabled', 'approval', 'unsupported'] as const)(
    '%s 时不重复推荐或尝试不支持的自启',
    async (state) => {
      fixture.startup.enabled = state === 'enabled';
      fixture.startup.requiresApproval = state === 'approval';
      fixture.startup.supported = state !== 'unsupported';
      const view = mount(AssistantSection, '启用 WeQ 助手');
      try {
        await view.click();
        expect(useDialog.getState().current).toBeNull();
        expect(fixture.mutate).toHaveBeenCalledTimes(1);
      } finally {
        view.close();
      }
    },
  );
  it.each([true, false])('关闭自启但助手仍启用时，可选择保留自启：%s', async (keep) => {
    fixture.startup.enabled = true;
    fixture.assistant.enabled = true;
    const view = mount(StartupSection, '开机自动启动 WeQ');
    try {
      await view.click();
      const dialog = useDialog.getState().current;
      expect(dialog?.message).toContain('助手');
      expect(fixture.mutate).not.toHaveBeenCalled();
      await act(async () => dialog!.confirm!.resolve(keep));
      expect(fixture.startup.enabled).toBe(keep);
      expect(fixture.assistant.enabled).toBe(true);
    } finally {
      view.close();
    }
  });
  it('提醒未结束时不能重复切换或覆盖当前确认框', async () => {
    const view = mount(AssistantSection, '启用 WeQ 助手');
    try {
      await view.click();
      const id = useDialog.getState().current?.id;
      await view.click();
      expect(useDialog.getState().current?.id).toBe(id);
      expect(fixture.mutate).toHaveBeenCalledTimes(1);
      await act(async () => useDialog.getState().current!.confirm!.resolve(false));
    } finally {
      view.close();
    }
  });
});
