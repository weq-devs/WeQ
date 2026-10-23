import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageUsageItem } from '@weq/service';
import { GlobalSettingsSection } from '../src/renderer/src/components/settings/GlobalSettingsSection';

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(async (_title: string, _body: string, _options: unknown) => true),
  clear: vi.fn(async () => ({ freedBytes: 1024, cleared: ['avatar'], failed: [] })),
  exitClear: vi.fn(async () => ({ scheduled: true })),
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
  ] as StorageUsageItem[],
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
            ? () => ({
                mutateAsync: path.at(-1) === 'clearStorageData' ? fixture.exitClear : fixture.clear,
                isLoading: false,
              })
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
  it('风险数据不参与默认清理，明确选择后提示不可恢复并走退出清除接口', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const originalLength = fixture.items.length;
    fixture.items.push({
      ...fixture.items[0],
      id: 'db_repair',
      label: '数据库修复工作区',
      path: '/synthetic/cache/db_repair',
      requiresExit: true,
      confirmation: '将删除修复备份，失去回滚能力，无法自动恢复。',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '清理缓存',
      )!;
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['avatar'] });
      expect(fixture.exitClear).not.toHaveBeenCalled();
      const checkbox = host.querySelector<HTMLInputElement>(
        'input[aria-label="数据库修复工作区"]',
      )!;
      expect(checkbox.checked).toBe(false);
      act(() => checkbox.closest('label')!.click());
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => button.click());
      expect(fixture.exitClear).not.toHaveBeenCalled();
      expect(fixture.confirm.mock.calls.at(-1)?.[1]).toContain('失去回滚能力');
      await act(async () => button.click());
      expect(fixture.exitClear).toHaveBeenCalledWith({ ids: ['db_repair'], acknowledgeRisk: true });
    } finally {
      act(() => root.unmount());
      host.remove();
      fixture.items.splice(originalLength);
    }
  });

  it('新增装扮项可单独选择，确认告知装扮影响，取消不清理', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const originalLength = fixture.items.length;
    fixture.items.push({
      ...fixture.items[0],
      id: 'dress_shared',
      label: '共享装扮资源缓存',
      path: '/synthetic/cache/dress_shared',
      confirmation: '共享装扮资源清理后需要重新进入账号，装扮设置不会删除。',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      act(() => host.querySelector<HTMLElement>('[data-weq-select-id="dress_shared"]')!.click());
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '清理所选',
      )!;
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => button.click());
      expect(fixture.clear).not.toHaveBeenCalled();
      expect(fixture.confirm.mock.calls[0][1]).toContain('重新进入账号');
      expect(fixture.confirm.mock.calls[0][1]).toContain('装扮设置不会删除');
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['dress_shared'] });
    } finally {
      act(() => root.unmount());
      host.remove();
      fixture.items.splice(originalLength);
    }
  });

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
      const toolbar = host.querySelector('.weq-storage-toolbar')!;
      expect(toolbar.nextElementSibling?.classList.contains('weq-set-cache-list')).toBe(true);
      const category = host.querySelector<HTMLDetailsElement>('.weq-storage-category')!;
      expect(category.open).toBe(false);
      expect(category.querySelector('summary')?.textContent).toContain('消息与搜索数据');
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

  it('同类数据折叠合并，系统文件不显示但占用仍计入合计', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const originalLength = fixture.items.length;
    fixture.items.push(
      { ...fixture.items[1], id: 'search', label: '全文搜索索引', path: '/synthetic/search-index' },
      { ...fixture.items[1], id: 'system', label: '.DS_Store', path: '/synthetic/.DS_Store' },
      { ...fixture.items[0], id: 'empty', label: '空缓存', bytes: 0 },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      expect(host.textContent).toContain('合计占用 7.0 KB');
      expect(host.textContent).not.toContain('.DS_Store');
      expect(host.textContent).not.toContain('空缓存');
      const categories = [...host.querySelectorAll('.weq-storage-category')];
      expect(categories).toHaveLength(2);
      expect(categories[0].querySelector('summary')?.textContent).toContain('4.0 KB');
      expect(categories[0].querySelectorAll('.is-readonly')).toHaveLength(2);
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      host.remove();
      fixture.items.splice(originalLength);
    }
  });
});
