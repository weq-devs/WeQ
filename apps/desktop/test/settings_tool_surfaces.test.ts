import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog, type SectionId } from '../src/renderer/src/components/SettingsDialog';
import { useSettingsMaintenance } from '../src/renderer/src/hooks/useSettingsMaintenance';
import { useAppLock } from '../src/renderer/src/state/lock';
import { useCaptureWindow } from '../src/renderer/src/state/captureWindow';
import { useUpdateStore } from '../src/renderer/src/state/update';
import {
  DataMaintenanceDialog,
  type MaintenanceTool,
} from '../src/renderer/src/components/settings/DataMaintenanceSection';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data:
              path.at(-1) === 'getAccountConfig'
                ? { uin: '10001', configId: 'synthetic', static: false }
                : undefined,
            isLoading: false,
            refetch: vi.fn(),
          });
        if (key === 'useMutation') return () => ({ mutate: vi.fn(), isLoading: false });
        if (key === 'query')
          return vi.fn().mockImplementation(async () => {
            if (path.includes('listTargets')) return [];
            if (path.includes('analyzeTree'))
              return {
                present: false,
                files: 0,
                bytes: 0,
                byMonth: {},
                ori: { files: 0, bytes: 0 },
                thumb: { files: 0, bytes: 0 },
                other: { files: 0, bytes: 0 },
              };
            return { autoAttachQq: false };
          });
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/views/cache/DbExplorer', () => ({
  DbExplorer: () => h('input', { 'aria-label': '合成数据库工具输入' }),
}));
vi.mock('../src/renderer/src/views/cache/CacheView', () => ({
  CacheView: () => h('div', null, '合成资源列表'),
}));
vi.mock('../src/renderer/src/components/settings/LogViewerPanel', () => ({
  LogViewerPanel: () => h('div', { 'data-log-viewer': true }, '合成日志'),
}));

afterEach(() => {
  useCaptureWindow.getState().dismiss();
  useAppLock.setState({ locked: false });
  useUpdateStore.setState({ available: false });
  vi.unstubAllGlobals();
});

function fixture(initialSection: SectionId = 'global') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let openTool: (tool: MaintenanceTool | null) => void = () => {};
  function View({ source }: { source: string }) {
    const { tool, setTool } = useSettingsMaintenance(source);
    openTool = setTool;
    return h(
      WorkspacePages,
      { navigationKey: source },
      h(WorkspaceContent, null, '合成聊天'),
      h(SettingsDialog, {
        open: true,
        initialSection,
        onClose: vi.fn(),
        onOpenMaintenance: setTool,
        onOpenRecalls: vi.fn(),
      }),
      h(DataMaintenanceDialog, {
        key: source,
        source,
        tool,
        account: { uin: '10001', name: '合成账号', avatarUrl: '' },
        onClose: () => setTool(null),
      }),
    );
  }
  act(() => root.render(h(View, { source: 'account:source-a' })));
  return {
    host,
    open: (tool: MaintenanceTool | null) => act(() => openTool(tool)),
    oldCallback: () => openTool,
    source: (source: string) => act(() => root.render(h(View, { source }))),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('设置来源工具不替换设置页面', () => {
  it('更新红点与分类文字共用第二列，不成为下一行的独立网格项', () => {
    useUpdateStore.setState({ available: true });
    const f = fixture();
    try {
      const mark = f.host.querySelector('.weq-settings-nav .weq-settings-update-mark')!;
      expect(mark).not.toBeNull();
      expect(mark.parentElement?.className).toBe('weq-settings-nav-label');
      expect(mark.parentElement?.textContent).toBe('关于 WeQ');
      expect(mark.closest('button')?.children).toHaveLength(2);
      act(() => useUpdateStore.setState({ available: false }));
      expect(f.host.querySelector('.weq-settings-nav .weq-settings-update-mark')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('数据库工具使用模态层，原设置、输入和滚动现场保持，关闭后归还焦点', () => {
    const f = fixture();
    try {
      const settings = f.host.querySelector('.weq-settings-dialog')!;
      const body = settings.querySelector<HTMLElement>('.weq-settings-body')!;
      const input = settings.querySelector<HTMLInputElement>('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '23',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      body.scrollTop = 137;
      act(() => input.focus());
      f.open('database');
      expect(settings.closest('[hidden]')).toBeNull();
      expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="合成数据库工具输入"]')).not.toBeNull();
      expect(f.host.querySelector('.weq-settings-dialog')).toBe(settings);
      f.open(null);
      expect(settings.querySelector('input')).toBe(input);
      expect(input.value).toBe('23');
      expect(body.scrollTop).toBe(137);
      expect(document.activeElement).toBe(input);
    } finally {
      f.close();
    }
  });

  it('Escape 只关闭工具，不关闭或隐藏底层设置', () => {
    const f = fixture();
    try {
      f.open('database');
      act(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      expect(document.querySelector('[aria-label="合成数据库工具输入"]')).toBeNull();
      expect(f.host.querySelector('.weq-settings-dialog')?.closest('[hidden]')).toBeNull();
    } finally {
      f.close();
    }
  });

  it.each(['cache', 'storage', 'cleanup', 'reverse', 'login-accounts'] as const)(
    '%s 使用相同的模态容器，底层设置保持可见但不可交互',
    async (tool) => {
      const f = fixture();
      try {
        await act(async () => f.open(tool));
        expect(document.querySelector('.weq-tool-modal[aria-modal="true"]')).not.toBeNull();
        expect(f.host.querySelector('.weq-settings-dialog')?.closest('[hidden]')).toBeNull();
        expect(f.host.hasAttribute('inert')).toBe(true);
        f.open(null);
        expect(f.host.hasAttribute('inert')).toBe(false);
      } finally {
        f.close();
      }
    },
  );

  it('同号不同来源、锁屏和旧回调均不能泄漏或恢复旧工具', () => {
    const f = fixture();
    try {
      f.open('database');
      const previous = f.oldCallback();
      f.source('account:source-b');
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      act(() => previous('database'));
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      f.open('cache');
      act(() => previous(null));
      expect(document.querySelector('.weq-tool-modal')).not.toBeNull();
      act(() => useAppLock.getState().lock());
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      act(() => useAppLock.getState().unlock());
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      f.source('account:source-a');
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('日志查看器留在设置正文，不创建模态层或新的工作区页面', () => {
    const f = fixture('logs');
    try {
      expect(f.host.querySelector('.weq-settings-body [data-log-viewer]')).not.toBeNull();
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      expect(f.host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});
