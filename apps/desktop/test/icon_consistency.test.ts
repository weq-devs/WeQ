import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';
import { SETTINGS_GROUPS } from '../src/renderer/src/components/settings/navigation';
import { AssistantSection } from '../src/renderer/src/components/settings/AssistantSection';
import { McpServerSection } from '../src/renderer/src/components/settings/McpServerSection';
import { AlbumExportLightbox } from '../src/renderer/src/views/export/AlbumExportLightbox';
import { GroupFileExportLightbox } from '../src/renderer/src/views/export/GroupFileExportLightbox';
import { NewGroupModal } from '../src/renderer/src/views/agentlab/NewGroupModal';

vi.mock('../src/renderer/src/trpc/client', () => {
  const data: Record<string, unknown> = {
    getAccountConfig: { uin: '10001', static: false },
    getWeqAssistantStatus: { running: false, port: 20001 },
    getMcpStatus: { running: false, port: 20002 },
    listGroupAlbums: [],
    listGroupFiles: { files: [], folders: [] },
  };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        const value = data[path.at(-1) ?? ''];
        if (key === 'useQuery')
          return () => ({ data: value, isLoading: false, isFetching: false, refetch: vi.fn() });
        if (key === 'useMutation')
          return () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isLoading: false });
        if (key === 'query') return async () => value;
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

async function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client: queries }, element)),
  );
  return {
    host,
    dispose() {
      act(() => root.unmount());
      queries.clear();
      host.remove();
    },
  };
}

function expectIcon(button: Element | null | undefined) {
  expect(button).toBeTruthy();
  const icon = button?.querySelector('svg');
  expect(icon).not.toBeNull();
  expect(icon?.closest('[aria-hidden="true"]')).not.toBeNull();
}

describe('操作图标的一致性', () => {
  it('七组设置二级导航都复用页面图标，同时保留按钮文字', async () => {
    const f = await mount(
      createElement(SettingsDialog, {
        open: true,
        initialSection: 'appearance',
        onClose: vi.fn(),
        onOpenMaintenance: vi.fn(),
      }),
    );
    try {
      for (const group of SETTINGS_GROUPS) {
        const nav = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-nav-item')].find(
          (button) => button.textContent === group.label,
        );
        await act(async () => nav?.click());
        const buttons = [...f.host.querySelectorAll('.weq-settings-subnav-item')];
        expect(buttons.length).toBe(group.sections.length);
        for (const button of buttons) {
          expectIcon(button);
          expect(button.textContent?.trim()).not.toBe('');
        }
      }
    } finally {
      f.dispose();
    }
  });

  it.each([
    ['公众号推送', AssistantSection],
    ['MCP', McpServerSection],
  ])('%s 端口保存与其他操作一样提供图标', async (_name, Component) => {
    const f = await mount(createElement(Component));
    try {
      expectIcon(
        [...f.host.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === '保存',
        ),
      );
    } finally {
      f.dispose();
    }
  });

  it.each([
    ['相册', AlbumExportLightbox, ['全选', '反选']],
    ['群文件', GroupFileExportLightbox, ['全选当前目录', '反选当前目录', '清空已选']],
  ])('%s 导出选择工具提供图标，取消按钮保持纯文字', async (_name, Component, labels) => {
    const f = await mount(
      createElement(Component, {
        groupCode: '20001',
        groupName: '合成群',
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    try {
      const buttons = [...f.host.querySelectorAll('button')];
      for (const label of labels)
        expectIcon(buttons.find((button) => button.textContent?.trim() === label));
      const cancel = buttons.find((button) => button.textContent?.trim() === '取消');
      expect(cancel).toBeTruthy();
      expect(cancel?.querySelector('svg')).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('克隆群聊创建提供图标但保留原有禁用条件', async () => {
    const f = await mount(
      createElement(NewGroupModal, { personas: [], onClose: vi.fn(), onCreate: vi.fn() }),
    );
    try {
      const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '创建群聊',
      );
      expectIcon(create);
      expect(create?.disabled).toBe(true);
    } finally {
      f.dispose();
    }
  });
});
