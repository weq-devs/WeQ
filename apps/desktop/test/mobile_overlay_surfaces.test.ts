import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRedBagQrcode } from '../src/renderer/src/components/RedBagQrcodeDialog.shared';
import { RedBagQrcodeHost } from '../src/renderer/src/components/RedBagQrcodeDialog';
import { AlbumExportLightbox } from '../src/renderer/src/views/export/AlbumExportLightbox';
import { GroupFileExportLightbox } from '../src/renderer/src/views/export/GroupFileExportLightbox';
import { FailureLightbox } from '../src/renderer/src/views/export/FailureLightbox';
import { ExportLightbox } from '../src/renderer/src/views/export/ExportLightbox';
import { mobileBack, mobileBackEntry } from '../src/renderer/src/hooks/useMobileNavigation';

vi.mock('../src/renderer/src/lib/target', async (original) => ({
  ...(await original<object>()),
  IS_WEB: true,
}));
vi.mock('../src/renderer/src/lib/target.shared', async (original) => ({
  ...(await original<object>()),
  IS_WEB: true,
}));
vi.mock('../src/renderer/src/views/export/preflight', () => ({
  ocrReadiness: async () => ({ localReady: false, onlineReady: false }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const data: Record<string, unknown> = {
    listGroupAlbums: [],
    listGroupAlbumBrowse: { albums: [], complete: true },
    listGroupFiles: { files: [], folders: [] },
    getGroupAlbumAccessState: { qqOnline: false, attachEnabled: false },
  };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        const value = data[path.at(-1) ?? ''];
        if (key === 'useQuery') return () => ({ data: value, isLoading: false, isFetching: false });
        if (key === 'query') return async () => value;
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.stubGlobal(
    'visualViewport',
    Object.assign(new EventTarget(), { height: 320, offsetTop: 96, scale: 1 }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('红包二维码向手机返回栈登记，返回后关闭而不是退出底层页面', async () => {
  await act(async () => {
    root.render(h(RedBagQrcodeHost));
    openRedBagQrcode({
      qrcodeBase64: '',
      lucky: false,
      password: false,
      totalNum: 1,
      totalAmount: 100,
    });
  });
  let consumed = false;
  act(() => {
    consumed = mobileBack();
  });
  expect(consumed).toBe(true);
  expect(document.querySelector('.weq-redbag-qr')).toBeNull();
});

const exportProps = { groupCode: '20001', groupName: '合成群', onConfirm: vi.fn() };
const cases: [string, (close: () => void) => ReactElement][] = [
  ['相册导出', (onClose) => h(AlbumExportLightbox, { ...exportProps, onClose })],
  ['群文件导出', (onClose) => h(GroupFileExportLightbox, { ...exportProps, onClose })],
  ['失败详情', (onClose) => h(FailureLightbox, { taskName: '合成任务', failures: [], onClose })],
  [
    '导出配置',
    (onClose) =>
      h(ExportLightbox, {
        variant: 'contacts',
        headline: '合成导出',
        summary: '合成范围',
        onClose,
        onConfirm: vi.fn(),
      }),
  ],
];
it.each(cases)(
  '%s 使用独立 Portal 和手机可视视口，手机返回一次只关闭当前层',
  async (_name, render) => {
    const close = vi.fn();
    await act(async () => root.render(render(close)));
    const layer = document.querySelector<HTMLElement>('.weq-web-dialog-layer');
    expect(layer?.parentElement).toBe(document.body);
    expect(layer?.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('320px');
    expect(layer?.style.getPropertyValue('--weq-mobile-viewport-top')).toBe('96px');
    act(() => {
      expect(mobileBack()).toBe(true);
    });
    expect(close).toHaveBeenCalledOnce();
  },
);

it('嵌入导出配置不注册弹层返回，隐藏再显示时保留同一表单节点', async () => {
  const render = (hidden: boolean) =>
    root.render(
      h(ExportLightbox, {
        embedded: true,
        hidden,
        variant: 'contacts',
        headline: '合成导出',
        summary: '合成范围',
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
  await act(async () => render(false));
  const form = host.querySelector('.weq-export-options');
  expect(form).not.toBeNull();
  expect(mobileBackEntry()).toBeUndefined();
  await act(async () => render(true));
  expect(host.querySelector('.weq-export-options')).toBe(form);
  expect(form?.hasAttribute('hidden')).toBe(true);
  await act(async () => render(false));
  expect(host.querySelector('.weq-export-options')).toBe(form);
});
