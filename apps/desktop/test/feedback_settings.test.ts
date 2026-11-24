import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { BugReportPanel } from '../src/renderer/src/components/settings/BugReportPanel';
import { SETTINGS_PAGE_LABELS } from '../src/renderer/src/components/settings/navigation';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots } from '../src/renderer/src/lib/pageSnapshots';
const f = vi.hoisted(() => ({
  enabled: [] as boolean[],
  external: vi.fn(),
  app: '',
  platform: 'linux',
  versionLoading: false,
  systemLoading: false,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getVersionInfo: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled.push(options.enabled);
          return { data: { app: f.app }, isLoading: f.versionLoading };
        },
      },
      systemInfo: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          f.enabled.push(options.enabled);
          return { data: { platformKind: f.platform }, isLoading: f.systemLoading };
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
  f.app = '';
  f.platform = 'linux';
  f.versionLoading = false;
  f.systemLoading = false;
  vi.unstubAllGlobals();
});

const SCOPE = 'feedback-fixture';
function mountFeedback() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (generation = 0) =>
    act(() =>
      root.render(h(PageSnapshots, { scope: SCOPE }, h(BugReportPanel, { key: generation }))),
    );
  render();
  return {
    host,
    render,
    body: () => host.querySelector<HTMLTextAreaElement>('[aria-label="反馈正文 Markdown"]')!,
    title: () => host.querySelector<HTMLInputElement>('[aria-label="反馈标题"]')!,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('自动模板不是未保存修改，重新挂载后仍无需离开确认', () => {
  const page = mountFeedback();
  try {
    const template = page.body().value;
    expect(template).toContain('## 错误的功能描述');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
    f.app = 'new-synthetic-version';
    page.render(1);
    expect(page.body().value).toBe(template);
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
  } finally {
    page.dispose();
  }
});

it.each(['version', 'system'] as const)(
  '等待 %s 信息后生成模板，不将异步填入视为修改',
  (pending) => {
    f.versionLoading = pending === 'version';
    f.systemLoading = pending === 'system';
    const page = mountFeedback();
    try {
      expect(page.body().value).toBe('');
      expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
      f.app = 'synthetic-version';
      f.platform = 'darwin';
      f.versionLoading = false;
      f.systemLoading = false;
      page.render();
      expect(page.body().value).toContain('synthetic-version');
      expect(page.body().value).toContain('macOS');
      expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
    } finally {
      page.dispose();
    }
  },
);

it('标题、正文和清单的实际修改需要确认，逐项还原后清除草稿标记', () => {
  const page = mountFeedback();
  try {
    const template = page.body().value;
    inputValue(page.title(), '合成反馈标题');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    inputValue(page.title(), '');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
    inputValue(page.body(), `${template}\n合成复现步骤`);
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    inputValue(page.body(), template);
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
    const check = [
      ...page.host.querySelectorAll<HTMLButtonElement>('.weq-help-bug-checks button'),
    ].find((button) => button.textContent === '我知道错误的原因')!;
    act(() => check.click());
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    act(() => check.click());
    expect(page.body().value).toBe(template);
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
  } finally {
    page.dispose();
  }
});

it('保留生成时的模板基准，清空正文后重建不重新填入或丢失修改', () => {
  const page = mountFeedback();
  try {
    inputValue(page.body(), '');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    f.app = 'new-synthetic-version';
    page.render(1);
    expect(page.body().value).toBe('');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    act(() => page.host.querySelector<HTMLButtonElement>('[title="重新填入模板"]')!.click());
    expect(page.body().value).toContain('new-synthetic-version');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(false);
  } finally {
    page.dispose();
  }
});

it('模板加载前的用户输入不被覆盖，生成基准后仍保留草稿标记', () => {
  f.versionLoading = true;
  const page = mountFeedback();
  try {
    inputValue(page.body(), '加载前输入的合成反馈');
    f.versionLoading = false;
    page.render();
    expect(page.body().value).toBe('加载前输入的合成反馈');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
    page.render(1);
    expect(page.body().value).toBe('加载前输入的合成反馈');
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(true);
  } finally {
    page.dispose();
  }
});

it.each([false, true])('兼容旧反馈草稿：有实际修改=%s', (edited) => {
  const page = mountFeedback();
  try {
    const body = page.body().value + (edited ? '\n合成复现步骤' : '');
    pageSnapshots.write(JSON.stringify([SCOPE, 'feedback:body']), body, true);
    pageSnapshots.resetScope(SCOPE);
    page.render(1);
    expect(page.body().value).toBe(body);
    expect(pageSnapshots.hasDrafts(SCOPE)).toBe(edited);
  } finally {
    page.dispose();
  }
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
    expect(textarea.value).toContain('设置 → 关于 → 版本与更新');
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
