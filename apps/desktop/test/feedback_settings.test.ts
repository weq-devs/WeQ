import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BugReportPanel } from '../src/renderer/src/components/settings/BugReportPanel';
import { SETTINGS_PAGE_LABELS } from '../src/renderer/src/components/settings/navigation';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
const f = vi.hoisted(() => ({ enabled: [] as boolean[], external: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getVersionInfo: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled.push(options.enabled);
          return { data: { app: '' } };
        },
      },
      systemInfo: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled.push(options.enabled);
          return { data: { platformKind: 'linux' } };
        },
      },
    },
    help: {
      ghStatus: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled.push(options.enabled);
          return { data: { available: false } };
        },
      },
    },
    account: {
      dbExplorer: {
        listDatabases: {
          useQuery: (_input: unknown, options: { enabled: boolean }) => {
            f.enabled.push(options.enabled);
            return { data: [], isLoading: false };
          },
        },
      },
    },
  },
  client: { help: { openExternal: { mutate: f.external } } },
}));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => h('article', null, children),
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it('反馈使用公共页标题/四个模块，保留编辑预览、hexdump 和三个提交入口但不自动提交', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active = true) =>
    act(() => root.render(h(TabActivity, { active }, h(BugReportPanel))));
  try {
    render();
    expect(host.querySelector('.weq-set-title')?.textContent).toBe(SETTINGS_PAGE_LABELS.feedback);
    expect(host.querySelectorAll('.weq-set-card')).toHaveLength(4);
    expect(host.querySelectorAll('.weq-help-bug-actions button')).toHaveLength(3);
    expect(host.querySelector('[aria-label="选择当前账号的数据库"]')).not.toBeNull();
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="反馈正文 Markdown"]')!;
    expect(textarea.value).toContain('关于 WeQ');
    expect(textarea.value).not.toContain('帮助与关于');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '合成反馈草稿',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '预览')!
        .click(),
    );
    expect(host.querySelector('article')?.textContent).toBe('合成反馈草稿');
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '编辑')!
        .click(),
    );
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="反馈正文 Markdown"]')?.value).toBe(
      '合成反馈草稿',
    );
    expect(f.external).not.toHaveBeenCalled();
    f.enabled = [];
    render(false);
    expect(f.enabled.length).toBeGreaterThan(0);
    expect(f.enabled.every((enabled) => !enabled)).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
