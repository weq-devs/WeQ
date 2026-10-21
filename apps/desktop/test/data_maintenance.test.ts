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
vi.mock('../src/renderer/src/views/cache/CacheView', () => ({
  CacheView: () => '本地缓存面板',
}));
vi.mock('../src/renderer/src/components/settings/HelpSection', () => ({
  HelpSection: () => '帮助子页面',
}));
vi.mock('../src/renderer/src/components/DbRepairPanel', () => ({
  DbRepairPanel: ({ currentUin }: { currentUin: string }) => {
    state.repairAccount = currentUin;
    return '修复面板';
  },
}));
vi.mock('../src/renderer/src/views/cache/ResourceAnalyticsDialog', async () => {
  const { createElement } = await import('react');
  const { WorkspacePage } = await import('../src/renderer/src/components/WorkspacePages');
  return {
    ResourceAnalyticsDialog: ({ onClose }: { onClose: () => void }) =>
      createElement(
        WorkspacePage,
        { title: '存储占用', onClose },
        '存储面板',
        createElement('button', { onClick: onClose, 'aria-label': '关闭' }, '关闭'),
      ),
  };
});
vi.mock('../src/renderer/src/views/cache/ResourceCleanupDialog', async () => {
  const { createElement } = await import('react');
  const { WorkspacePage } = await import('../src/renderer/src/components/WorkspacePages');
  return {
    ResourceCleanupDialog: ({ onClose }: { onClose: () => void }) =>
      createElement(
        WorkspacePage,
        { title: '清理缓存', onClose },
        '清理面板',
        createElement('button', { onClick: onClose, 'aria-label': '关闭' }, '关闭'),
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
  it('帮助可从设置分类打开，且不叠加独立弹窗', () => {
    const f = mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'maintenance',
        onClose: vi.fn(),
        onOpenMaintenance: vi.fn(),
        onOpenRecalls: vi.fn(),
      }),
    );
    try {
      const help = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-nav-item')].find(
        (button) => button.textContent === '帮助与关于',
      );
      expect(help).toBeDefined();
      act(() => help!.click());
      expect(f.host.querySelector('.weq-settings-body')?.textContent).toBe('帮助子页面');
      expect(f.host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
      expect(f.host.querySelectorAll('[role="dialog"], [aria-modal="true"]')).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
  it('高级诊断入口归设置，分别打开抓包与解析，不启动诊断动作', () => {
    const open = vi.fn();
    const f = mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'diagnostics',
        onClose: vi.fn(),
        onOpenMaintenance: open,
        onOpenRecalls: vi.fn(),
      }),
    );
    try {
      expect(entries(f.host).map((button) => button.textContent)).toEqual([
        'ntqq 抓包',
        'Protobuf / JCE 逆向',
      ]);
      for (const button of entries(f.host)) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual(['capture', 'reverse']);
    } finally {
      f.dispose();
    }
  });
  it('API 用量在设置内展示，不要求进入克隆对话', () => {
    const f = mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'model-usage',
        onClose: vi.fn(),
        onOpenMaintenance: vi.fn(),
        onOpenRecalls: vi.fn(),
      }),
    );
    try {
      expect(f.host.querySelector('.weq-settings-model-usage')).not.toBeNull();
      expect(f.host.textContent).toContain('API 用量');
    } finally {
      f.dispose();
    }
  });
  it('防撤回作为设置分区嵌入，不再叠加独立遮罩', () => {
    const f = mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'anti-recall',
        onClose: vi.fn(),
        onOpenMaintenance: vi.fn(),
        onOpenRecalls: vi.fn(),
      }),
    );
    try {
      expect(f.host.querySelector('[aria-label="防撤回设置"]')).not.toBeNull();
      expect(f.host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
      expect(f.host.querySelectorAll('[role="dialog"], [aria-modal="true"]')).toHaveLength(0);
      expect(f.host.querySelector('.group-keyword-scrim')).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('本地缓存与原有四项按顺序收纳，点击不触发维护操作', () => {
    const open = vi.fn();
    const f = mount(createElement(DataMaintenanceSection, { onOpen: open }));
    try {
      expect(entries(f.host).map((button) => button.textContent)).toEqual([
        '本地缓存',
        '数据库管理',
        '存储占用',
        '清理缓存',
        '数据库修复',
        '导出明文数据库',
        '密钥扫描',
        '其它设备密钥',
      ]);
      for (const button of entries(f.host)) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual([
        'cache',
        'database',
        'storage',
        'cleanup',
        'db-repair',
        'db-decrypt',
        'key-scan',
        'other-device-key',
      ]);
    } finally {
      f.dispose();
    }
  });
  it('静态账号明确禁用本地资源功能，不隐藏数据库维护', () => {
    state.account = { static: true };
    const f = mount(createElement(DataMaintenanceSection, { onOpen: vi.fn() }));
    try {
      expect(entries(f.host).map((button) => button.disabled)).toEqual([
        true,
        false,
        true,
        true,
        false,
        false,
        false,
        false,
      ]);
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
  it.each(['cache', 'database', 'storage', 'cleanup', 'db-repair', 'db-decrypt'] as const)(
    '%s 从设置进入工具后只有一个内容页且不遮罩，关闭返回原设置分区',
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
            onOpenRecalls: vi.fn(),
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
        const index = [
          'cache',
          'database',
          'storage',
          'cleanup',
          'db-repair',
          'db-decrypt',
        ].indexOf(tool);
        act(() => entries(f.host)[index]!.click());
        expect(f.host.querySelector('.weq-settings-dialog')).toBeNull();
        if (tool === 'storage' || tool === 'cleanup') {
          expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
        } else {
          expect(
            document.querySelectorAll('.weq-workspace-page .weq-maintenance-dialog'),
          ).toHaveLength(1);
          expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
        }
        if (tool === 'db-repair') expect(state.repairAccount).toBe('10001');
        expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(0);
        // 所有维护子页统一右上角关闭按钮，不再有左上角返回箭头。
        expect(document.querySelector('.weq-maintenance-head')?.textContent ?? '').not.toContain(
          '返回数据与维护',
        );
        const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.getAttribute('aria-label') === '关闭',
        )!;
        act(() => back.click());
        expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
          '数据与存储',
        );
        expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
        expect(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).toHaveLength(0);
      } finally {
        f.dispose();
      }
    },
  );
});
