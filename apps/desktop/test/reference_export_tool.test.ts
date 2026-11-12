import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ReferenceExportTool } from '../src/renderer/src/views/export/ReferenceExportTool';
import type { ContentReference } from '../src/shared/content_selection';

const f = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'task'),
  prepare: vi.fn(
    async () =>
      ({ mode: 'before' as const, directory: '.' }) as { mode: 'before'; directory: string } | null,
  ),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { startAlbumReferenceExport: { mutate: f.start } } },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    isCurrent: () => true,
    prepareSave: f.prepare,
  }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => f.toast }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  f.prepare.mockResolvedValue({ mode: 'before', directory: '.' });
});
const items: ContentReference[] = [
  { kind: 'qzone-photo', uin: '10002', albumId: 'a', mediaKey: 'same-name', name: '甲照片' },
  { kind: 'qzone-photo', uin: '10002', albumId: 'b', mediaKey: 'same-name', name: '乙照片' },
];
async function mount(initial = items) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ReferenceExportTool, { initial })));
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
it('范围直接可勾选，报告选项内联，一次开始即提交冻结后的精确集合', async () => {
  const view = await mount();
  try {
    expect(view.host.textContent).not.toContain('编辑列表');
    const checks = [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks).toHaveLength(2);
    expect(checks.every((input) => input.checked && !input.disabled)).toBe(true);
    await act(async () => checks[0]!.click());
    await act(async () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    const start = [...view.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('开始导出'),
    )!;
    await act(async () => {
      start.click();
      start.click();
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({ items: [items[1]], includeIntegrityReport: true }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(items).toHaveLength(2);
  } finally {
    await view.close();
  }
});
it('取消保存不创建任务，不清空选择；大集合只挂载可视行', async () => {
  f.prepare.mockResolvedValue(null);
  const view = await mount(
    Array.from({ length: 1000 }, (_, index) => ({
      kind: 'qzone-photo' as const,
      uin: '10002',
      albumId: `album-${index}`,
      mediaKey: 'same',
      name: `照片 ${index}`,
    })),
  );
  try {
    expect(view.host.querySelectorAll('input[type="checkbox"]').length).toBeLessThan(30);
    const start = [...view.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('开始导出'),
    )!;
    await act(async () => start.click());
    expect(f.start).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('已选 1000 项内容');
    await act(async () =>
      view.host.querySelector<HTMLButtonElement>('[aria-label="反选"]')!.click(),
    );
    expect(view.host.textContent).toContain('已选 0 项内容');
    expect(start.disabled).toBe(true);
  } finally {
    await view.close();
  }
});
