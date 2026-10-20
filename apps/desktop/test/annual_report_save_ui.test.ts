import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy, ReportPageManifest } from '@weq/service';
import { EndPage } from '../src/renderer/src/views/annual-report/pages/EndPage';
import { annualReportExportOutput } from '../src/shared/annual_report_export';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const state = vi.hoisted(() => ({
  year: 2025,
  web: false,
  configId: 'source-a',
  slides: [] as unknown[],
  scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  overlay: { current: null as HTMLDivElement | null },
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'after',
    }),
  ),
  html: vi.fn(async (_input: unknown): Promise<string | null> => 'html-task'),
  pdf: vi.fn(async (_input: unknown): Promise<string | null> => 'pdf-task'),
  png: vi.fn(async (_input: unknown): Promise<string | null> => 'png-task'),
  preload: vi.fn(
    async (_slides: unknown[], _resolve: (url: string) => Promise<string | null>) => {},
  ),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => {
    const configId = state.configId;
    return {
      binding: { expectedAccountUin: '10001', expectedAccountConfigId: configId },
      settings: { isLoading: false },
      chooseServerLocation: vi.fn(),
      prepareSave: state.prepare,
      isCurrent: () => configId === state.configId,
    };
  },
}));
vi.mock('../src/renderer/src/views/annual-report/reportContext', () => ({
  useReportView: () => ({
    year: state.year,
    slides: state.slides,
    readScope: state.scope,
    overlayHostRef: state.overlay,
  }),
}));
vi.mock('../src/renderer/src/views/annual-report/exportHtml', () => ({
  preloadReportAssets: state.preload,
  buildReportHtml: (year: number) => `<html>report-${year}</html>`,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getGroupAlbumAccessState: { query: async () => ({ qqOnline: false }) },
      annualReport: {
        exportHtml: { mutate: state.html },
        exportPdf: { mutate: state.pdf },
        exportLongImage: { mutate: state.png },
      },
    },
  },
}));
const page: ReportPageManifest = {
  id: 'end',
  title: '结尾',
  description: '',
  order: 99,
  version: '1',
  apiVersion: 1,
  category: 'end',
  enabledByDefault: true,
};
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.year = 2025;
  state.web = false;
  state.configId = 'source-a';
  state.prepare.mockReset().mockResolvedValue({ mode: 'after' });
  state.html.mockClear();
  state.pdf.mockClear();
  state.png.mockClear();
  state.toast.mockClear();
  state.preload.mockReset().mockResolvedValue();
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const portal = document.createElement('div');
  document.body.append(portal);
  state.overlay.current = portal;
  const root = createRoot(host);
  const render = () =>
    act(async () => root.render(h(EndPage, { page, data: { year: state.year }, active: true })));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
    portal.remove();
    state.overlay.current = null;
  });
  await render();
  const layout = process.env.WEQ_REPORT_SAVE_LAYOUT;
  if (layout) {
    mkdirSync(layout, { recursive: true });
    const styles = [
      'index.css',
      'annual-report.css',
      'export-save-actions.css',
      'annual-report-save.css',
    ]
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(layout, state.web ? 'report-web.html' : 'report-desktop.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;width:100%;height:100%;font-family:system-ui}*,*::before,*::after{box-sizing:border-box}</style><body><main class="weq-report-root">${host.innerHTML}</main></body></html>`,
    );
  }
  return { host, portal, render };
}
async function exportClick(host: HTMLElement, label: string) {
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('.weq-end-take-btn')]
      .find((node) => node.querySelector('.weq-end-take-name')?.textContent === label)!
      .click(),
  );
}
it.each([
  ['HTML', 'html'],
  ['PDF', 'pdf'],
  ['长图', 'png'],
] as const)('%s 使用真实单文件形态与公共保存，排队不冒称已导出', async (label, format) => {
  const view = await mount();
  await exportClick(view.host, label);
  const output = annualReportExportOutput(2025, format);
  expect(state.prepare).toHaveBeenCalledWith(undefined, {
    kind: 'file',
    name: output.name,
    format,
  });
  expect(state[format]).toHaveBeenCalledWith({
    ...state.scope,
    year: 2025,
    html: '<html>report-2025</html>',
    savePolicy: { mode: 'after' },
  });
  expect(state.toast.mock.calls[0]![0]).toMatchObject({
    tone: 'info',
    title: '报告保存任务已创建',
  });
});
it('本次菜单留在报告浮层宿主内，取消选择不创建任务', async () => {
  const view = await mount();
  state.prepare.mockResolvedValueOnce(null);
  act(() =>
    view.host.querySelector<HTMLButtonElement>('[aria-label="HTML 本次保存选项"]')!.click(),
  );
  const menu = view.portal.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  await act(async () =>
    [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent === '另存到…')!
      .click(),
  );
  expect(state.prepare.mock.calls[0]![0]).toEqual({ mode: 'before' });
  expect(state.html).not.toHaveBeenCalled();
  expect(state.toast).not.toHaveBeenCalled();
});
it('准备位置期间切换来源，不提交旧报告，也不把晚到结果提示给新来源', async () => {
  const view = await mount();
  state.prepare.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return { mode: 'after' };
  });
  await exportClick(view.host, 'HTML');
  expect(state.html).not.toHaveBeenCalled();
  await view.render();
  expect(
    view.host.querySelector<HTMLButtonElement>('[aria-label="HTML 本次保存选项"]')!.disabled,
  ).toBe(true);
});
it('年份变化后不复用上一个年份的 HTML 缓存', async () => {
  const view = await mount();
  state.year = 2024;
  let release!: () => void;
  state.preload.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await view.render();
  await exportClick(view.host, 'HTML');
  expect(state.html).toHaveBeenCalledWith(
    expect.objectContaining({ year: 2024, html: '<html>report-2024</html>' }),
  );
  await act(async () => release());
});
it('Web 导出标明服务器保存，菜单仍使用本次服务器位置', async () => {
  state.web = true;
  const view = await mount();
  expect(view.host.querySelectorAll('.weq-end-take-hint')[0]?.textContent).toBe('保存到服务器');
  act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="PDF 本次保存选项"]')!.click());
  expect(view.portal.textContent).toContain('另存到服务器…');
});
it('末页内容过高时优先保留原生滚动，到边缘后再交给报告翻页', async () => {
  const view = await mount();
  const canvas = view.host.querySelector<HTMLElement>('.weq-report-canvas')!;
  Object.defineProperties(canvas, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  canvas.scrollTop = 10;
  const stage = vi.fn();
  view.host.addEventListener('wheel', stage);
  const first = new WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true });
  view.host.querySelector('.weq-end')!.dispatchEvent(first);
  expect(stage).not.toHaveBeenCalled();
  expect(first.defaultPrevented).toBe(false);
  canvas.scrollTop = 400;
  view.host
    .querySelector('.weq-end')!
    .dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true }));
  expect(stage).toHaveBeenCalledOnce();
});
