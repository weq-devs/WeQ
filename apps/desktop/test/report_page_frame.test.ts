import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OverviewPage } from '../src/renderer/src/views/annual-report/pages/OverviewPage';
import { buildReportHtml } from '../src/renderer/src/views/annual-report/exportHtml';

const manifest = {
  id: 'overview',
  title: '总览',
  description: '',
  order: 1,
  version: '1',
  apiVersion: 1,
  category: '合成',
  enabledByDefault: true,
};

it('两份同页报告的可访问标题各有独立身份', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          ...['第一份', '第二份'].map((title) =>
            createElement(OverviewPage, {
              key: title,
              page: { ...manifest, title },
              active: true,
              data: {
                year: 2026,
                totalSent: 2,
                totalReceived: 1,
                c2cSent: 1,
                groupSent: 1,
                spanDays: 1,
                firstMessageTime: null,
              },
            }),
          ),
        ),
      ),
    );
    const pages = [...host.querySelectorAll('section')];
    const ids = pages.map((page) => page.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
    for (const [i, page] of pages.entries()) {
      expect(page.querySelector('h1')?.id).toBe(ids[i]);
      expect(page.querySelector('h1')?.textContent).toBe(i === 0 ? '第一份' : '第二份');
    }
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('导出空间日期与屏幕共用北京日历，跨年时不退回上一年', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  try {
    const time = Date.parse('2026-01-01T00:00:00+08:00') / 1000;
    const html = buildReportHtml(0, [
      {
        page: { ...manifest, id: 'qzone' },
        data: {
          year: 0,
          firstPostTime: time,
          gallery: [{ tid: 'synthetic', time, content: '合成条目', images: [] }],
          highlight: null,
        },
      },
    ]);
    expect(html).toContain('2026年1月1日');
    expect(html).toContain('2026 年');
    expect(html).not.toContain('2025年12月31日');
  } finally {
    vi.unstubAllEnvs();
  }
});
