import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GlobalSettingsSection } from '../src/renderer/src/components/settings/GlobalSettingsSection';

const f = vi.hoisted(() => ({
  settings: { windowsStyleControls: false },
  save: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.at(-1) === 'getSettings' ? f.settings : undefined,
              isLoading: false,
              refetch: f.refetch,
            })
          : key === 'useMutation'
            ? () => ({ mutateAsync: f.save, isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/settings/ToastSettingsCard', () => ({
  ToastSettingsCard: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['darwin', 'linux', 'win32'])(
  '%s 只在支持平台展示开关并保存到全局配置',
  async (platform) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('electron', { process: { platform } });
    f.settings = { windowsStyleControls: false };
    f.save.mockResolvedValue(true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(GlobalSettingsSection)));
      const toggle = host.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="使用仿 Windows 窗口按钮"]',
      );
      if (platform === 'win32') {
        expect(toggle).toBeNull();
        return;
      }
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(host.textContent).toContain('账号选择页保持统一样式');
      await act(async () => toggle!.click());
      expect(f.save).toHaveBeenCalledWith({ enabled: true });
      expect(f.refetch).toHaveBeenCalledOnce();
      f.settings = { windowsStyleControls: true };
      act(() => root.render(createElement(GlobalSettingsSection)));
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
      await act(async () => toggle!.click());
      expect(f.save).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
