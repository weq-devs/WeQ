import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataMaintenanceSection,
  type MaintenanceTool,
} from '../src/renderer/src/components/settings/DataMaintenanceSection';
import {
  MAINTENANCE_TOOLS,
  remoteUnsupportedTools,
} from '../src/renderer/src/components/settings/DataMaintenanceSection.shared';
import { DataMaintenanceDialog } from '../src/renderer/src/components/settings/DataMaintenanceDialog';
import { useDbRepairWindow } from '../src/renderer/src/state/dbRepairWindow';
import { useCaptureWindow } from '../src/renderer/src/state/captureWindow';
import { useDatabaseBrowserWindow } from '../src/renderer/src/state/databaseBrowserWindow';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';
import type { ToolPresentation } from '../src/renderer/src/components/ToolSurface';
import { useViewState } from '../src/renderer/src/state/view';

const state = vi.hoisted(() => ({
  account: { static: false, uin: '10001', configId: 'synthetic' } as
    | { static: boolean; uin?: string; configId?: string }
    | undefined,
  failed: false,
  fetching: false,
  remote: false,
  refetch: vi.fn(),
  repairAccount: '',
}));
vi.mock('../src/renderer/src/lib/remoteClient', () => ({
  isRemoteClient: () => state.remote,
  useRemoteClient: () => state.remote,
}));
vi.mock('../src/renderer/src/views/cache/useResourceManagementScan', () => ({
  useResourceManagementScan: (source: {
    expectedAccountUin: string;
    expectedAccountConfigId: string;
  }) => ({
    source,
    stats: [],
    targets: [],
    scanningKey: null,
    complete: true,
    error: null,
    revision: 1,
    refresh: async () => {},
  }),
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
                    isFetching: state.fetching,
                    error: state.failed ? new Error('账号读取失败') : null,
                    refetch: state.refetch,
                  }
                : { data: undefined, isLoading: false }
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/views/cache/DbExplorer', () => ({
  DbExplorer: ({
    onExport,
    exportDisabled,
  }: {
    onExport?: (database: { name: string; path: string }) => void;
    exportDisabled?: boolean;
  }) =>
    createElement(
      'div',
      null,
      '数据库面板',
      onExport
        ? createElement(
            'button',
            {
              'data-setting-id': 'database-export',
              disabled: exportDisabled,
              onClick: () => onExport({ name: 'synthetic.db', path: '/synthetic/synthetic.db' }),
            },
            '导出',
          )
        : null,
    ),
}));
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
  const { ToolSurface } = await import('../src/renderer/src/components/ToolSurface');
  return {
    ResourceAnalyticsDialog: ({
      onClose,
      presentation,
      embedded,
    }: {
      onClose: () => void;
      presentation?: ToolPresentation;
      embedded?: boolean;
    }) =>
      embedded
        ? '存储面板'
        : createElement(
            ToolSurface,
            { title: '存储占用', onClose, presentation },
            '存储面板',
            createElement('button', { onClick: onClose, 'aria-label': '关闭' }, '关闭'),
          ),
  };
});
vi.mock('../src/renderer/src/views/cache/ResourceCleanupDialog', async () => {
  const { createElement } = await import('react');
  const { ToolSurface } = await import('../src/renderer/src/components/ToolSurface');
  return {
    ResourceCleanupDialog: ({
      onClose,
      presentation,
      embedded,
    }: {
      onClose: () => void;
      presentation?: ToolPresentation;
      embedded?: boolean;
    }) =>
      embedded
        ? '清理面板'
        : createElement(
            ToolSurface,
            { title: '清理缓存', onClose, presentation },
            '清理面板',
            createElement('button', { onClick: onClose, 'aria-label': '关闭' }, '关闭'),
          ),
  };
});
afterEach(() => {
  useCaptureWindow.getState().dismiss();
  vi.unstubAllGlobals();
  state.account = { static: false, uin: '10001', configId: 'synthetic' };
  useViewState.setState({ openedUin: null });
  state.failed = false;
  state.fetching = false;
  state.remote = false;
  state.refetch.mockClear();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.setState({ openedUin: '10001' });
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
  return [
    ...host.querySelectorAll<HTMLButtonElement>(
      '.weq-data-maintenance button[data-setting-id], button[data-setting-id="qqnt-capture"]',
    ),
  ];
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
        (button) => button.textContent === '关于 WeQ',
      );
      expect(help).toBeDefined();
      act(() => help!.click());
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '版本与更新',
      );
      expect(f.host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
      expect(f.host.querySelectorAll('[role="dialog"], [aria-modal="true"]')).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
  it('高级诊断页直接显示逆向内容，抓包仍保留独立工具启动入口', () => {
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
      expect(entries(f.host).map((button) => button.textContent)).toEqual(['打开抓包']);
      expect(entries(f.host)[0]?.closest('.weq-set-card')?.textContent).toContain('QQNT 抓包');
      expect(entries(f.host)[0]?.closest('.weq-set-card-head')).not.toBeNull();
      expect(f.host.querySelector('.weq-maintenance-entry')).toBeNull();
      expect(f.host.querySelector('[data-setting-id="reverse-tool"] textarea')).not.toBeNull();
      for (const button of entries(f.host)) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual(['capture']);
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
      expect(
        [...f.host.querySelectorAll('.weq-set-row-label')].map((row) => row.textContent),
      ).toEqual([
        '资源查看',
        MAINTENANCE_TOOLS.find(({ id }) => id === 'database')!.label,
        '占用分析',
        '缓存清理',
        MAINTENANCE_TOOLS.find(({ id }) => id === 'db-repair')!.label,
        '导出明文数据库',
        '密钥扫描',
        '其他设备密钥',
      ]);
      expect(entries(f.host).every((button) => button.classList.contains('weq-set-btn'))).toBe(
        true,
      );
      expect(f.host.querySelector('.weq-maintenance-entry')).toBeNull();
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
  it('密钥工具共用卡片，只有行内按钮启动对应工具', () => {
    const open = vi.fn();
    const f = mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'credentials',
        onClose: vi.fn(),
        onOpenMaintenance: open,
        onOpenRecalls: vi.fn(),
      }),
    );
    try {
      const buttons = entries(f.host);
      expect(buttons.map((button) => button.textContent)).toEqual(['打开密钥扫描', '查看设备密钥']);
      const card = buttons[0]!.closest('.weq-set-card');
      expect(card).not.toBeNull();
      expect(card?.querySelector('.weq-set-card-title')?.textContent).toBe('密钥工具');
      expect(buttons[1]!.closest('.weq-set-card')).toBe(card);
      expect(card?.querySelector('.weq-set-card')).toBeNull();
      for (const label of card!.querySelectorAll<HTMLElement>('.weq-set-row-label')) {
        act(() => label.click());
      }
      expect(open).not.toHaveBeenCalled();
      for (const button of buttons) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual(['key-scan', 'other-device-key']);
    } finally {
      f.dispose();
    }
  });
  it('已有账号刷新期间仍禁用工具按钮，避免打开未确认来源', () => {
    state.fetching = true;
    const open = vi.fn();
    const f = mount(createElement(DataMaintenanceSection, { onOpen: open }));
    try {
      expect(entries(f.host).every((button) => button.disabled)).toBe(true);
      for (const button of entries(f.host)) act(() => button.click());
      expect(open).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it('账号尚未载入时保留按钮和读取状态，不允许启动工具', () => {
    state.account = undefined;
    const open = vi.fn();
    const f = mount(createElement(DataMaintenanceSection, { onOpen: open }));
    try {
      expect(entries(f.host)).toHaveLength(8);
      expect(entries(f.host).every((button) => button.disabled)).toBe(true);
      expect(f.host.querySelector('[role="status"]')?.textContent).toContain('正在读取当前账号');
      for (const button of entries(f.host)) act(() => button.click());
      expect(open).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it('远程端继续隐藏不支持的本机工具', () => {
    state.remote = true;
    const open = vi.fn();
    const f = mount(createElement(DataMaintenanceSection, { onOpen: open }));
    try {
      const visibleTools = MAINTENANCE_TOOLS.filter(
        ({ id }) => id !== 'login-accounts' && !remoteUnsupportedTools.includes(id),
      );
      expect(entries(f.host).map((button) => button.textContent)).toEqual(
        visibleTools.map(({ actionLabel }) => actionLabel),
      );
      for (const button of entries(f.host)) act(() => button.click());
      expect(open.mock.calls.map(([tool]) => tool)).toEqual(visibleTools.map(({ id }) => id));
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
    '%s 保留设置原页，数据库浏览独立开窗、资源内嵌、导出模态',
    (tool) => {
      let openTool: (tool: MaintenanceTool) => void = () => {};
      function Harness() {
        const [settings, setSettings] = useState(true);
        const [active, setActive] = useState<MaintenanceTool | null>(null);
        openTool = setActive;
        return createElement(
          'div',
          null,
          createElement(SettingsDialog, {
            open: settings,
            initialSection:
              tool === 'cache' || tool === 'storage' || tool === 'cleanup'
                ? 'qq-storage'
                : tool === 'db-repair'
                  ? 'database-repair'
                  : 'database-management',
            onClose: () => setSettings(false),
            onOpenMaintenance: (next) => {
              setActive(next);
            },
            onOpenRecalls: vi.fn(),
          }),
          createElement(DataMaintenanceDialog, {
            source: 'synthetic:maintenance',
            tool: active,
            account: { uin: '10001', name: '测试账号', avatarUrl: '' },
            onClose: () => {
              setActive(null);
            },
          }),
        );
      }
      const f = mount(createElement(Harness));
      try {
        const settings = f.host.querySelector('.weq-settings-dialog');
        if (tool === 'database') {
          expect(f.host.textContent).not.toContain('数据库面板');
          const open = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
            button.textContent?.includes('打开数据库浏览'),
          )!;
          vi.spyOn(window, 'open').mockReturnValue(null);
          act(() => open.click());
          expect(useDatabaseBrowserWindow.getState().request).not.toBeNull();
          useDatabaseBrowserWindow.getState().dismiss();
          expect(document.querySelector('.weq-tool-modal')).toBeNull();
          expect(f.host.querySelector('.weq-settings-dialog')).toBe(settings);
          return;
        }
        if (tool === 'cache' || tool === 'storage' || tool === 'cleanup') {
          const settingId = {
            cache: 'resource-viewer',
            storage: 'qq-storage-analysis',
            cleanup: 'qq-storage-cleanup',
          }[tool];
          act(() =>
            f.host
              .querySelector(`[data-setting-id="${settingId}"]`)!
              .closest<HTMLButtonElement>('button')!
              .click(),
          );
          expect(f.host.querySelector('.weq-settings-dialog')).toBe(settings);
          expect(f.host.textContent).toContain(
            { cache: '本地缓存面板', storage: '存储面板', cleanup: '清理面板' }[tool],
          );
          expect(document.querySelector('.weq-tool-modal')).toBeNull();
          expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
          return;
        }
        const entryId = {
          cache: 'resource-viewer',
          database: 'database-manager',
          storage: 'qq-storage-analysis',
          cleanup: 'qq-storage-cleanup',
          'db-repair': 'database-repair',
          'db-decrypt': 'database-export',
        }[tool];
        if (tool === 'db-decrypt') act(() => openTool(tool));
        else
          act(() =>
            f.host
              .querySelector<HTMLButtonElement>(`button[data-setting-id="${entryId}"]`)!
              .click(),
          );
        expect(f.host.querySelector('.weq-settings-dialog')).toBe(settings);
        expect(settings?.closest('[hidden]')).toBeNull();
        if (tool === 'db-repair') {
          expect(useDbRepairWindow.getState().request?.uin).toBe('10001');
          expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
          expect(document.querySelector('.weq-tool-modal')).toBeNull();
          useDbRepairWindow.getState().dismiss();
          return;
        }
        expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
        expect(document.querySelectorAll('.weq-tool-modal .weq-maintenance-dialog')).toHaveLength(
          1,
        );
        expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
        // 所有维护子页统一右上角关闭按钮，不再有左上角返回箭头。
        expect(document.querySelector('.weq-page-head')?.textContent ?? '').not.toContain(
          '返回数据与维护',
        );
        const back = [
          ...document.querySelectorAll<HTMLButtonElement>('.weq-tool-modal button'),
        ].find((button) => button.getAttribute('aria-label') === '关闭')!;
        act(() => back.click());
        expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
          '凭据与数据',
        );
        expect(document.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
        expect(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).toHaveLength(0);
      } finally {
        f.dispose();
      }
    },
  );
});
