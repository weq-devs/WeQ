import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import faqMarkdown from '../../../resources/help/faq.md?raw';
import { FaqPanel } from '../src/renderer/src/components/settings/FaqPanel';
import { SETTINGS_PAGE_LABELS } from '../src/renderer/src/components/settings/navigation';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
const f = vi.hoisted(() => ({ ok: true, enabled: false, text: '合成帮助文档' }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    help: {
      getFaqMarkdown: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled = options.enabled;
          return {
            data: { ok: f.ok, text: f.text, path: '/synthetic/help/faq.md' },
            isLoading: false,
          };
        },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.ok = true;
  f.text = '合成帮助文档';
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
  expect(page.host.querySelector('.weq-help-md')?.textContent).toBe('合成帮助文档');
  page.render(false);
  expect(f.enabled).toBe(false);
});
it('文件不可用时保持页标题和模块，只显示读取失败而非空白页', () => {
  f.ok = false;
  const page = fixture();
  expect(page.host.querySelector('.weq-set-title')?.textContent).toBe(SETTINGS_PAGE_LABELS.faq);
  expect(page.host.textContent).toContain('常见问题文件缺失或读取失败');
  expect(page.host.querySelector('.weq-help-md')).toBeNull();
});
it('正式 FAQ 的主题目录在页内滚动并将焦点转到对应标题', () => {
  f.text = faqMarkdown;
  const { host } = fixture();
  const links = host.querySelectorAll<HTMLAnchorElement>('a[href^="#"]');
  const headings = [...host.querySelectorAll('h2')];
  const originalHash = window.location.hash;
  expect(links.length).toBeGreaterThan(0);
  expect(host.querySelectorAll('hr')).toHaveLength(links.length);

  for (const link of links) {
    const heading = headings.find((item) => item.textContent === link.textContent)!;
    const scroll = vi.spyOn(heading, 'scrollIntoView');
    act(() => link.click());
    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalled();
    scroll.mockRestore();
  }
  expect(window.location.hash).toBe(originalHash);
});
it('FAQ 文档链接直接新窗打开，点击不弹出外链确认', () => {
  const url = 'https://example.com/guide/macos-debug-copy.html';
  f.text = `[macOS 调试副本](${url})`;
  const page = fixture();
  const link = page.host.querySelector<HTMLAnchorElement>('.weq-help-md a');
  expect(link).not.toBeNull();
  expect(link?.href).toBe(url);
  expect(link?.target).toBe('_blank');
  expect(link?.rel).toContain('noreferrer');
  let intercepted = true;
  page.host.addEventListener('click', (event) => {
    intercepted = event.defaultPrevented;
    event.preventDefault();
  });
  act(() => link!.click());
  expect(intercepted).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Open external link?');
});
