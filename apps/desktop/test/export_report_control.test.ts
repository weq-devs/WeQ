import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useExportReportDialog } from '../src/renderer/src/views/export/ExportReportControl';

afterEach(() => vi.unstubAllGlobals());

it('统一批量导出弹窗默认关闭报告，确认传递选择，取消与卸载结算等待', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const results: Array<boolean | null> = [];
  function Fixture() {
    const report = useExportReportDialog();
    return h(
      'div',
      null,
      h(
        'button',
        {
          onClick: () => {
            void report.choose().then((value) => results.push(value));
          },
        },
        '批量导出',
      ),
      report.dialog,
    );
  }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(h(Fixture)));
    await click('批量导出');
    expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    await click('开始导出');
    expect(results).toEqual([false]);
    await click('批量导出');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await click('开始导出');
    expect(results).toEqual([false, true]);
    await click('批量导出');
    expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    await click('取消');
    expect(results).toEqual([false, true, null]);
    await click('批量导出');
    await act(async () => root.unmount());
    expect(results).toEqual([false, true, null, null]);
  } finally {
    if (host.firstChild) await act(async () => root.unmount());
    host.remove();
  }
});
