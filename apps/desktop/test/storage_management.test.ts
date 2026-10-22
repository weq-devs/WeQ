import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSettingsSection } from '../src/renderer/src/components/settings/GlobalSettingsSection';

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  clear: vi.fn(async () => ({ freedBytes: 1024, cleared: ['avatar'], failed: [] })),
  refetch: vi.fn(),
  items: [
    {
      id: 'avatar',
      label: '头像缓存',
      path: '/synthetic/cache/avatar',
      bytes: 1024,
      clearable: true,
      reason: '按需下载',
      incomplete: false,
    },
    {
      id: 'ocr',
      label: '图片识别结果',
      path: '/synthetic/cache/ocr',
      bytes: 2048,
      clearable: false,
      reason: '持久数据',
      incomplete: false,
    },
  ],
}));

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.at(-1) === 'listStorageUsage' ? fixture.items : undefined,
              refetch: fixture.refetch,
              isLoading: false,
              isFetching: false,
            })
          : key === 'useMutation'
            ? () => ({ mutateAsync: fixture.clear, isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (selector: (state: unknown) => unknown) =>
    selector({ confirm: fixture.confirm, showError: vi.fn() }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (selector: (state: unknown) => unknown) => selector({ push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WeQ 存储管理页面', () => {
  it('只读项目没有复选框、不参与全选和清理请求', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      expect(host.textContent).toContain('WeQ 存储管理');
      expect(host.textContent).toContain('合计占用 3.0 KB');
      expect(host.textContent).toContain('可清理 1.0 KB');
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      const readonly = host.querySelector<HTMLElement>('.is-readonly')!;
      expect(readonly.textContent).toContain('图片识别结果');
      expect(readonly.querySelector('input')).toBeNull();
      expect(readonly.hasAttribute('data-weq-select-id')).toBe(false);
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '清理缓存',
      )!;
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['avatar'] });
      expect(fixture.confirm.mock.calls[0]).not.toContain('图片识别结果');
      expect(fixture.refetch).toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
