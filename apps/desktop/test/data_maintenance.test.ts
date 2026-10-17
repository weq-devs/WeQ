import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataMaintenanceSection,
  DataMaintenanceDialog,
  type MaintenanceTool,
} from '../src/renderer/src/components/settings/DataMaintenanceSection';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';

const state = vi.hoisted(() => ({
  account: { static: false } as { static: boolean } | undefined,
  failed: false,
  refetch: vi.fn(),
  repairAccount: '',
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () =>
              path.includes('getAccountConfig')
                ? {
                    data: state.account,
                    isError: state.failed,
                    error: new Error('账号读取失败'),
                    refetch: state.refetch,
                  }
                : { data: undefined, isLoading: false }
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/views/cache/DbExplorer', () => ({ DbExplorer: () => '数据库面板' }));
vi.mock('../src/renderer/src/components/DbRepairPanel', () => ({
  DbRepairPanel: ({ currentUin }: { currentUin: string }) => {
    state.repairAccount = currentUin;
    return '修复面板';
  },
}));
vi.mock('../src/renderer/src/views/cache/ResourceAnalyticsDialog', async () => {
  const { createElement } = await import('react');
  return {
    ResourceAnalyticsDialog: ({ onClose }: { onClose: () => void }) =>
      createElement(
        'div',
        { role: 'dialog' },
        '存储面板',
        createElement('button', { onClick: onClose }, '返回数据与维护'),
      ),
  };
});
vi.mock('../src/renderer/src/views/cache/ResourceCleanupDialog', async () => {
  const { createElement } = await import('react');
  return {
    ResourceCleanupDialog: ({ onClose }: { onClose: () => void }) =>
      createElement(
        'div',
        { role: 'dialog' },
        '清理面板',
        createElement('button', { onClick: onClose }, '返回数据与维护'),
      ),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.account = { static: false };
  state.failed = false;
  state.refetch.mockClear();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function entries(host: Element) {
  return [...host.querySelectorAll<HTMLButtonElement>('.weq-maintenance-entry')];
}

describe('设置的数据与维护', () => {
  it('四项按原顺序安置，点击只打开指定面板，不触发维护操作', () => {
    const open = vi.fn();
    const f = mount(createElement(DataMaintenanceSection, { onOpen: open }));
    try {
      expect(entries(f.host).map((button) => button.textContent)).toEqual([
        '数据库管理',
        '存储占用',
        '清理缓存',
        '数据库修复',
      ]);
      for (const button of entries(f.host)) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual([
        'database',
        'storage',
        'cleanup',
        'db-repair',
      ]);
    } finally {
      f.dispose();
    }
  });
  it('静态账号明确禁用本地资源功能，不隐藏数据库维护', () => {
    state.account = { static: true };
    const f = mount(createElement(DataMaintenanceSection, { onOpen: vi.fn() }));
    try {
      expect(entries(f.host).map((button) => button.disabled)).toEqual([false, true, true, false]);
      expect(f.host.textContent).toContain('静态账号不可用');
    } finally {
      f.dispose();
    }
  });
  it('加载及读取失败时不允许打开未知账号功能，可重试', () => {
    state.account = undefined;
    state.failed = true;
    const f = mount(createElement(DataMaintenanceSection, { onOpen: vi.fn() }));
    try {
      expect(entries(f.host).every((button) => button.disabled)).toBe(true);
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('账号读取失败');
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-maintenance-status button')!.click());
      expect(state.refetch).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
  it.each(['database', 'storage', 'cleanup', 'db-repair'] as const)(
    '%s 从设置进入工具后只有一层对话框，关闭返回原设置分区',
    (tool) => {
      function Harness() {
        const [settings, setSettings] = useState(true);
        const [active, setActive] = useState<MaintenanceTool | null>(null);
        return createElement(
          'div',
          null,
          createElement(SettingsDialog, {
            open: settings,
            initialSection: 'maintenance',
            onClose: () => setSettings(false),
            onOpenMaintenance: (next) => {
              setSettings(false);
              setActive(next);
            },
          }),
          createElement(DataMaintenanceDialog, {
            tool: active,
            account: { uin: '10001', name: '测试账号', avatarUrl: '' },
            onClose: () => {
              setActive(null);
              setSettings(true);
            },
          }),
        );
      }
      const f = mount(createElement(Harness));
      try {
        const index = ['database', 'storage', 'cleanup', 'db-repair'].indexOf(tool);
        act(() => entries(f.host)[index]!.click());
        expect(f.host.querySelector('.weq-settings-dialog')).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
        if (tool === 'db-repair') expect(state.repairAccount).toBe('10001');
        const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) =>
            button.getAttribute('aria-label') === '返回数据与维护' ||
            button.textContent === '返回数据与维护',
        )!;
        act(() => back.click());
        expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
          '数据与维护',
        );
        expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
      } finally {
        f.dispose();
      }
    },
  );
});
