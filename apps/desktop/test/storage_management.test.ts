import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageUsageItem } from '@weq/service';
import { GlobalSettingsSection } from '../src/renderer/src/components/settings/GlobalSettingsSection';

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(async (_title: string, _body: string, _options: unknown) => true),
  clear: vi.fn(async (_input: unknown) => ({
    freedBytes: 1024,
    cleared: ['avatar'],
    failed: [] as Array<{ id?: string; label: string; error: string; retryAfterRestart?: boolean }>,
    scheduled: false,
    restartIds: [] as string[],
  })),
  exitClear: vi.fn(async (_input: unknown) => ({ scheduled: true })),
  push: vi.fn(),
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
      category: 'persistent',
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
                mutateAsync:
                  path.at(-1) === 'clearStorageData'
                    ? (input: { afterExit?: boolean }) =>
                        input.afterExit ? fixture.exitClear(input) : fixture.clear(input)
                    : fixture.clear,
                isLoading: false,
              })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (selector: (state: unknown) => unknown) =>
    selector({ confirm: fixture.confirm, showError: vi.fn() }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (selector: (state: unknown) => unknown) => selector({ push: fixture.push }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WeQ 存储管理页面', () => {
  it('同类缓存只显示一行，选择后清除全部来源，空项目及空分类不显示', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const length = fixture.items.length;
    fixture.items.push(
      {
        ...fixture.items[0]!,
        id: 'old-avatar',
        path: '/old/avatar',
        label: '头像缓存（默认目录）',
      },
      {
        ...fixture.items[0]!,
        id: 'empty',
        path: '/empty',
        label: '空装扮',
        bytes: 0,
        category: 'dress',
      },
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      expect(host.querySelectorAll('input[aria-label="头像缓存"]')).toHaveLength(1);
      expect(host.textContent).not.toContain('空装扮');
      expect(host.textContent).not.toContain('表情与装扮缓存');
      act(() => host.querySelector<HTMLElement>('[data-weq-select-id="avatar"]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '开始清理')!
          .click(),
      );
      expect(fixture.clear).toHaveBeenCalledWith({
        ids: ['avatar', 'old-avatar'],
        acknowledgeRisk: true,
      });
    } finally {
      act(() => root.unmount());
      fixture.items.splice(length);
    }
  });
  it('数据库备份置顶并默认展开，配置与闪传成品不计入本页占用或默认清理', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const length = fixture.items.length;
    fixture.items.push(
      {
        ...fixture.items[0]!,
        id: 'database-backup',
        label: '合成账号 · nt_msg.db',
        category: 'db-backups',
        action: 'db-backup',
        requiresExit: true,
        backup: {
          account: '合成账号',
          database: 'nt_msg.db',
          at: '2026-11-05T00:00:00Z',
          status: 'linked',
        },
      },
      {
        ...fixture.items[0]!,
        id: 'config',
        label: '账号与应用配置',
        management: 'backup',
        action: 'data',
        requiresExit: true,
        bytes: 1024 ** 3,
      },
      {
        ...fixture.items[0]!,
        id: 'flash',
        label: '历史闪传下载',
        management: 'downloads',
        clearable: false,
        bytes: 1024 ** 3,
      },
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      const first = host.querySelector<HTMLDetailsElement>('.weq-storage-category')!;
      expect(first.querySelector('summary')?.textContent).toContain('历史数据库备份');
      expect(first.open).toBe(true);
      expect(first.textContent).toContain('已关联修复记录');
      expect(host.textContent).toContain('本页占用 4 KB');
      expect(host.textContent).not.toContain('账号与应用配置');
      expect(host.textContent).not.toContain('历史闪传下载');
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '开始清理')!
          .click(),
      );
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['avatar'], acknowledgeRisk: true });
    } finally {
      act(() => root.unmount());
      fixture.items.splice(length);
    }
  });

  it('存储管理不再提供账号或全局配置删除按钮', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const length = fixture.items.length;
    fixture.items.push(
      {
        ...fixture.items[0]!,
        id: 'config',
        path: '/synthetic/config',
        label: '账号与应用配置',
        management: 'backup',
        action: 'data',
        requiresExit: true,
        confirmation: '将删除账号配置，需要重新登录。',
      },
      {
        ...fixture.items[0]!,
        id: 'global-config',
        path: '/synthetic/config.json',
        label: '全局配置',
        management: 'backup',
        action: 'data',
        requiresExit: true,
        confirmation: '将重置全局设置。',
      },
      {
        ...fixture.items[0]!,
        id: 'runtime',
        path: '/synthetic/profile/Preferences',
        label: '桌面运行数据 / Preferences',
        management: 'runtime',
        clearable: false,
      },
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(GlobalSettingsSection, {
            section: 'storage',
            heading: false,
          }),
        ),
      );
      expect(host.textContent).toContain('头像缓存');
      expect(host.textContent).not.toContain('清除账号与应用配置');
      expect(host.textContent).not.toContain('重置全局配置');
      expect(fixture.clear).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      fixture.items.splice(length);
    }
  });

  it('直接清理先完成，取消重启保留剩余项，再次确认只重试被占用项目', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const length = fixture.items.length;
    fixture.items.push({
      ...fixture.items[0]!,
      id: 'agentlab',
      label: '克隆数据',
      requiresExit: true,
    });
    fixture.clear.mockResolvedValueOnce({
      scheduled: false,
      freedBytes: 1024,
      cleared: ['avatar'],
      failed: [
        { id: 'agentlab', label: '克隆数据', error: '当前运行实例占用', retryAfterRestart: true },
      ],
      restartIds: ['agentlab'],
    });
    fixture.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const click = async (label: string) =>
      act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.trim() === label)!
          .click(),
      );
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      act(() => {
        host.querySelector<HTMLElement>('[data-weq-select-id="avatar"]')!.click();
        host.querySelector<HTMLElement>('[data-weq-select-id="agentlab"]')!.click();
      });
      await click('开始清理');
      expect(fixture.clear).toHaveBeenCalledWith({
        ids: ['avatar', 'agentlab'],
        acknowledgeRisk: true,
      });
      expect(fixture.confirm).toHaveBeenLastCalledWith(
        '剩余项目被占用',
        expect.stringContaining('可直接清除的项目已经处理'),
        expect.objectContaining({ cancelLabel: '暂不重启' }),
      );
      expect(fixture.exitClear).not.toHaveBeenCalled();
      expect(host.querySelector<HTMLInputElement>('input[aria-label="头像缓存"]')!.checked).toBe(
        false,
      );
      expect(host.querySelector<HTMLInputElement>('input[aria-label="克隆数据"]')!.checked).toBe(
        true,
      );
      await click('重启并清除剩余项目');
      expect(fixture.exitClear).toHaveBeenCalledWith({
        ids: ['agentlab'],
        acknowledgeRisk: true,
        afterExit: true,
      });
    } finally {
      act(() => root.unmount());
      host.remove();
      fixture.items.splice(length);
    }
  });

  it('非占用失败显示原因，不提示或执行重启', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.clear.mockResolvedValueOnce({
      scheduled: false,
      freedBytes: 0,
      cleared: [],
      failed: [{ id: 'avatar', label: '头像缓存', error: '读取不完整', retryAfterRestart: false }],
      restartIds: [],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '开始清理')!
          .click(),
      );
      expect(fixture.confirm).toHaveBeenCalledTimes(1);
      expect(fixture.exitClear).not.toHaveBeenCalled();
      expect(fixture.push).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: expect.stringContaining('读取不完整') }),
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('风险数据不参与默认清理，明确选择后先直接清除，成功不提示重启', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const originalLength = fixture.items.length;
    fixture.items.push({
      ...fixture.items[0],
      id: 'backup:test',
      label: '历史数据库备份 · nt_msg.db',
      path: '/synthetic/cache/db_repair/account/backups/test',
      category: 'db-backups',
      action: 'db-backup',
      requiresExit: true,
      confirmation: '将删除修复备份，失去回滚能力，无法自动恢复。',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(GlobalSettingsSection, { section: 'storage' })));
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '开始清理',
      )!;
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['avatar'], acknowledgeRisk: true });
      expect(fixture.exitClear).not.toHaveBeenCalled();
      const checkbox = host.querySelector<HTMLInputElement>(
        'input[aria-label="历史数据库备份 · nt_msg.db"]',
      )!;
      expect(checkbox.checked).toBe(false);
      act(() => checkbox.closest('label')!.click());
      expect(button.textContent).toBe('开始清理');
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => button.click());
      expect(fixture.exitClear).not.toHaveBeenCalled();
      expect(fixture.confirm.mock.calls.at(-1)?.[1]).toContain('失去回滚能力');
      expect(fixture.confirm).toHaveBeenLastCalledWith(
        '清除所选数据',
        expect.stringContaining('先清除可直接清除的项目'),
        expect.objectContaining({ okLabel: '清除' }),
      );
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['backup:test'], acknowledgeRisk: true });
      expect(fixture.exitClear).not.toHaveBeenCalled();
      expect(fixture.push).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: '清理已完成',
        }),
      );
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
        (item) => item.textContent === '开始清理',
      )!;
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => button.click());
      expect(fixture.clear).not.toHaveBeenCalled();
      expect(fixture.confirm.mock.calls[0][1]).toContain('重新进入账号');
      expect(fixture.confirm.mock.calls[0][1]).toContain('装扮设置不会删除');
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['dress_shared'], acknowledgeRisk: true });
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
      expect(host.textContent).toContain('本页占用 3 KB');
      expect(host.textContent).toContain('可清理 1 KB');
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      const readonly = host.querySelector<HTMLElement>('.is-readonly')!;
      const toolbar = host.querySelector('.weq-storage-toolbar')!;
      expect(toolbar.nextElementSibling?.classList.contains('weq-set-cache-list')).toBe(true);
      const category = [...host.querySelectorAll<HTMLDetailsElement>('.weq-storage-category')].find(
        (item) => item.textContent?.includes('图片识别结果'),
      )!;
      expect(category.open).toBe(false);
      expect(category.querySelector('summary')?.textContent).toContain('持久数据');
      expect(readonly.textContent).toContain('图片识别结果');
      expect(readonly.querySelector('input')).toBeNull();
      expect(readonly.hasAttribute('data-weq-select-id')).toBe(false);
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '开始清理',
      )!;
      const list = host.querySelector('.weq-set-cache-list')!;
      expect(list.nextElementSibling?.contains(button)).toBe(true);
      expect(button.parentElement?.nextElementSibling).toBeNull();
      expect(toolbar.contains(button)).toBe(false);
      await act(async () => button.click());
      expect(fixture.clear).toHaveBeenCalledWith({ ids: ['avatar'], acknowledgeRisk: true });
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
      expect(host.textContent).toContain('本页占用 7 KB');
      expect(host.textContent).not.toContain('.DS_Store');
      expect(host.textContent).not.toContain('空缓存');
      const categories = [...host.querySelectorAll('.weq-storage-category')];
      expect(categories).toHaveLength(2);
      const persistent = categories.find((item) =>
        item.querySelector('summary')?.textContent?.includes('持久数据'),
      )!;
      expect(persistent.querySelector('summary')?.textContent).toContain('6 KB');
      expect(persistent.querySelectorAll('.is-readonly')).toHaveLength(2);
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      host.remove();
      fixture.items.splice(originalLength);
    }
  });
});
