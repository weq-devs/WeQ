import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FaqPanel } from '../src/renderer/src/components/settings/FaqPanel';
import { SETTINGS_PAGE_LABELS } from '../src/renderer/src/components/settings/navigation';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
const f = vi.hoisted(() => ({ ok: true, enabled: false }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    help: {
      getFaqMarkdown: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled = options.enabled;
          return {
            data: { ok: f.ok, text: '合成帮助文档', path: '/synthetic/help/faq.md' },
            isLoading: false,
          };
        },
      },
    },
  },
}));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => h('article', null, children),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.ok = true;
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active = true) => act(() => root.render(h(TabActivity, { active }, h(FaqPanel))));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render };
}
it('FAQ 使用公共页标题和单个模块，保留文件信息与 Markdown 正文', () => {
  const page = fixture();
  expect(page.host.querySelector('.weq-set-title')?.textContent).toBe(SETTINGS_PAGE_LABELS.faq);
  expect(page.host.querySelectorAll('.weq-set-card')).toHaveLength(1);
  expect(page.host.querySelector('.weq-help-faq-head')).toBeNull();
  expect(page.host.textContent).toContain('faq.md');
  expect(page.host.querySelector('article')?.textContent).toBe('合成帮助文档');
  page.render(false);
  expect(f.enabled).toBe(false);
});
it('文件不可用时保持页标题和模块，只显示读取失败而非空白页', () => {
  f.ok = false;
  const page = fixture();
  expect(page.host.querySelector('.weq-set-title')?.textContent).toBe(SETTINGS_PAGE_LABELS.faq);
  expect(page.host.textContent).toContain('常见问题文件缺失或读取失败');
  expect(page.host.querySelector('article')).toBeNull();
});
