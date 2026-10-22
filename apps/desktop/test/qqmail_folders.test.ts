// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailPage as MailPageData, MailStatus } from '@weq/service/mail';
import { SYSTEM_MAIL_FOLDERS } from '@weq/service/mail-wire';
import { MailPage } from '../src/renderer/src/views/mail/MailPage';
import type { MailApi } from '../src/renderer/src/views/mail/api';
import type { ExportSavePolicy } from '@weq/service';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const saveState = vi.hoisted(() => ({
  current: true,
  web: false,
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'after',
    }),
  ),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return saveState.web;
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    settings: { isLoading: false },
    prepareSave: saveState.prepare,
    isCurrent: () => saveState.current,
  }),
}));

const ready: MailStatus = {
  state: 'ready',
  unread: 1,
  notifications: false,
  lastSync: null,
  error: null,
};
function page(subject = '合成收件箱邮件'): MailPageData {
  return {
    items: [
      {
        id: 'fixture-mail',
        folderId: 1,
        messageId: '',
        subject,
        snippet: '',
        sender: { email: 'sender@example.invalid', name: '' },
        to: [],
        cc: [],
        bcc: [],
        time: 1,
        size: 1,
        unread: true,
        starred: false,
        hasAttachments: false,
        draft: false,
      },
    ],
    page: 0,
    total: 1,
    unread: 1,
    hasMore: false,
  };
}
function fixture() {
  const list = vi.fn<MailApi['list']>().mockResolvedValue(page());
  const api: MailApi = {
    status: vi.fn(async () => ready),
    connect: vi.fn(async () => ready),
    disconnect: vi.fn(async () => {}),
    folders: vi.fn(async () => [...SYSTEM_MAIL_FOLDERS]),
    list,
    read: vi.fn(async () => {
      throw new Error('未使用正文夹具');
    }),
    action: vi.fn(async () => {}),
    send: vi.fn(async () => ({ state: 'accepted' as const, id: '', messageId: '' })),
    notifications: vi.fn(async () => ready),
    upload: vi.fn(async () => null),
    download: vi.fn(async () => false),
    save: vi.fn(async () => 'attachment-task'),
    exportMessages: vi.fn(async () => 'mail-export-task'),
    image: vi.fn(async () => ({ mime: 'image/png', base64: '' })),
    subscribe: vi.fn(() => () => {}),
    openLink: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { api, list };
}
beforeEach(() => {
  saveState.current = true;
  saveState.web = false;
  saveState.prepare.mockReset().mockResolvedValue({ mode: 'after' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount(
  api: MailApi,
  searchTarget?: { id: string; folderId: number; revision: string },
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MailPage, { api, selfEmail: 'self@example.invalid', searchTarget })),
  );
  return {
    host,
    setActive: (active: boolean) =>
      act(async () =>
        root.render(
          createElement(MailPage, {
            api,
            selfEmail: 'self@example.invalid',
            searchTarget,
            active,
          }),
        ),
      ),
    search: (target: { id: string; folderId: number; revision: string }) =>
      act(async () =>
        root.render(
          createElement(MailPage, { api, selfEmail: 'self@example.invalid', searchTarget: target }),
        ),
      ),
    clickInbox: () =>
      act(async () =>
        host.querySelector<HTMLButtonElement>('.weq-mail-folders [title="收件箱"]')!.click(),
      ),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('邮箱文件夹重复选择', () => {
  it('所选邮件导出沿用公共保存策略与来源绑定，取消选择不创建任务', async () => {
    const { api } = fixture();
    const f = await mount(api);
    try {
      await act(async () =>
        f.host.querySelector<HTMLInputElement>('[aria-label="选择当前页全部邮件"]')!.click(),
      );
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选邮件"]')!.click(),
      );
      expect(api.exportMessages).toHaveBeenCalledWith(
        ['fixture-mail'],
        { mode: 'after' },
        'source-a',
      );
      saveState.prepare.mockResolvedValueOnce(null);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选邮件"]')!.click(),
      );
      expect(api.exportMessages).toHaveBeenCalledTimes(1);
    } finally {
      f.close();
    }
  });
  it('进入与恢复前台自动读取，隐藏和离线取消读取，保留写信草稿且不重发操作', async () => {
    const { api, list } = fixture();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const view = await mount(api);
    try {
      expect(list).toHaveBeenCalledTimes(1);
      expect(view.host.querySelector('[aria-label="刷新邮箱"]')).toBeNull();
      act(() => view.host.querySelector<HTMLButtonElement>('.weq-mail-primary')!.click());
      const subject = view.host.querySelector<HTMLInputElement>('[aria-label="邮件主题"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          subject,
          '未保存的主题',
        );
        subject.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const firstSignal = list.mock.calls[0]![1]!;
      visibility.mockReturnValue('hidden');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(firstSignal.aborted).toBe(true);
      list.mockResolvedValue(page('恢复后新邮件'));
      online.mockReturnValue(false);
      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(list).toHaveBeenCalledTimes(1);
      online.mockReturnValue(true);
      await act(async () => window.dispatchEvent(new Event('online')));
      expect(list).toHaveBeenCalledTimes(2);
      expect(subject.value).toBe('未保存的主题');
      expect(view.host.textContent).toContain('恢复后新邮件');
      await view.setActive(false);
      expect(list.mock.calls[1]![1]!.aborted).toBe(true);
      await view.setActive(true);
      expect(list).toHaveBeenCalledTimes(3);
      expect(api.subscribe).toHaveBeenCalledTimes(1);
      expect(api.send).not.toHaveBeenCalled();
      expect(api.action).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
  it('搜索命中直接读取不透明邮件 id，不依赖当前列表的第一页', async () => {
    const { api, list } = fixture();
    const view = await mount(api, {
      id: '@opaque-mail-id',
      folderId: 5,
      revision: 'search-fixture',
    });
    try {
      expect(api.read).toHaveBeenCalledWith('@opaque-mail-id', expect.any(AbortSignal));
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ folderId: 5 }),
        expect.any(AbortSignal),
      );
      expect(api.read).not.toHaveBeenCalledWith('fixture-mail', expect.anything());
      await view.search({ id: '@opaque-mail-id', folderId: 5, revision: 'search-again' });
      expect(api.read).toHaveBeenCalledTimes(2);
    } finally {
      view.close();
    }
  });
  it('重复点击当前收件箱会重新加载，不留下空列表，也不重建会话订阅', async () => {
    const { api, list } = fixture(),
      view = await mount(api);
    try {
      expect(view.host.querySelectorAll('.weq-mail-row-main')).toHaveLength(1);
      for (let i = 0; i < 3; i++) {
        await view.clickInbox();
        expect(list).toHaveBeenCalledTimes(i + 2);
        expect(view.host.querySelectorAll('.weq-mail-row-main')).toHaveLength(1);
      }
      expect(api.subscribe).toHaveBeenCalledOnce();
      expect(api.status).toHaveBeenCalledOnce();
      expect(api.dispose).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
  it('重复点击期间取消旧请求，晚到响应不能覆盖新列表', async () => {
    const { api, list } = fixture(),
      view = await mount(api);
    let release: ((value: MailPageData) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    try {
      list.mockImplementationOnce((_input, signal) => {
        oldSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      list.mockResolvedValueOnce(page('最新列表'));
      await view.clickInbox();
      expect(list).toHaveBeenCalledTimes(2);
      await view.clickInbox();
      expect(oldSignal?.aborted).toBe(true);
      expect(view.host.textContent).toContain('最新列表');
      await act(async () => release?.(page('旧响应')));
      expect(view.host.textContent).toContain('最新列表');
      expect(view.host.textContent).not.toContain('旧响应');
    } finally {
      view.close();
    }
  });
});

async function attachmentView() {
  const { api } = fixture();
  vi.mocked(api.read).mockResolvedValue({
    ...page().items[0]!,
    html: '<p>合成正文</p>',
    replyTo: null,
    attachments: [{ id: 'attachment-token', name: 'README', size: 7, available: true, big: false }],
  });
  const view = await mount(api);
  await act(async () => view.host.querySelector<HTMLButtonElement>('.weq-mail-row-main')!.click());
  const layout = process.env.WEQ_MAIL_SAVE_LAYOUT;
  if (layout) {
    mkdirSync(layout, { recursive: true });
    const styles = ['index.css', 'mail.css', 'export-save-actions.css']
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(layout, saveState.web ? 'mail-web.html' : 'mail-desktop.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;height:100%;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}</style><body>${view.host.innerHTML}</body></html>`,
    );
  }
  return { ...view, api };
}

describe('邮箱修饰键多选', () => {
  async function selectionView() {
    const { api, list } = fixture();
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      ...page().items[0]!,
      id,
      subject: `邮件 ${id}`,
    }));
    list.mockResolvedValue({ ...page(), items, total: 60, hasMore: true });
    vi.mocked(api.read).mockImplementation(async (id) => ({
      ...items.find((item) => item.id === id)!,
      html: '<p>合成正文</p>',
      replyTo: null,
      attachments: [],
    }));
    const view = await mount(api);
    return {
      ...view,
      api,
      list,
      click: (id: string, modifiers: MouseEventInit = {}, checkbox = false) =>
        act(async () => {
          const target = checkbox
            ? view.host.querySelector(`[aria-label="选择 邮件 ${id}"]`)
            : view.host.querySelector(`[data-weq-select-id="${id}"]`);
          target!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
        }),
      checked: () =>
        [...view.host.querySelectorAll<HTMLInputElement>('.weq-mail-row > input')]
          .filter((input) => input.checked)
          .map((input) => input.getAttribute('aria-label')!.replace('选择 邮件 ', '')),
    };
  }

  it('Ctrl 与 ⌘ 点击切换单封，选中行高亮且不读取正文', async () => {
    const f = await selectionView();
    try {
      await f.click('a', { ctrlKey: true });
      await f.click('c', { metaKey: true });
      expect(f.checked()).toEqual(['a', 'c']);
      expect(f.host.querySelectorAll('.weq-mail-row.is-selected')).toHaveLength(2);
      await f.click('a', { ctrlKey: true });
      expect(f.checked()).toEqual(['c']);
      expect(f.api.read).not.toHaveBeenCalled();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="标为未读"]')!.click(),
      );
      expect(f.api.action).toHaveBeenCalledWith(['c'], 'unread');
    } finally {
      f.close();
    }
  });

  it('普通打开建立锚点，Shift 正反向范围替换，⌘＋Shift 追加范围', async () => {
    const f = await selectionView();
    try {
      await f.click('c');
      expect(f.api.read).toHaveBeenCalledWith('c', expect.any(AbortSignal));
      expect(f.checked()).toEqual([]);
      await f.click('e', { shiftKey: true });
      expect(f.checked()).toEqual(['c', 'd', 'e']);
      await f.click('a', { shiftKey: true });
      expect(f.checked()).toEqual(['a', 'b', 'c']);
      await f.click('e', { metaKey: true, shiftKey: true });
      expect(f.checked()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(f.api.read).toHaveBeenCalledTimes(1);
    } finally {
      f.close();
    }
  });

  it('复选框共用范围锚点，修饰键 pointerdown 后 click 不会重复切换', async () => {
    const f = await selectionView();
    try {
      await f.click('b', {}, true);
      await f.click('d', { shiftKey: true }, true);
      expect(f.checked()).toEqual(['b', 'c', 'd']);
      const button = f.host.querySelector<HTMLButtonElement>('[data-weq-select-id="e"]')!;
      act(() => {
        button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, ctrlKey: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      });
      expect(f.checked()).toEqual(['b', 'c', 'd', 'e']);
      expect(f.api.read).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each(['下一页', '收件箱', '未读', '搜索'])('%s 后清空选择和旧锚点', async (action) => {
    const f = await selectionView();
    try {
      await f.click('a', { ctrlKey: true });
      await f.click('c', { shiftKey: true });
      await act(async () => {
        if (action === '收件箱')
          f.host.querySelector<HTMLButtonElement>('.weq-mail-folders [title="收件箱"]')!.click();
        else if (action === '未读')
          f.host.querySelector<HTMLInputElement>('.weq-mail-list-heading input')!.click();
        else if (action === '搜索')
          f.host
            .querySelector<HTMLFormElement>('.weq-mail-search')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        else f.host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click();
      });
      expect(f.checked()).toEqual([]);
      await f.click('e', { shiftKey: true });
      expect(f.checked()).toEqual(['e']);
    } finally {
      f.close();
    }
  });

  it('自动刷新移除失效选择和锚点，不把旧邮件带入批量操作', async () => {
    const f = await selectionView();
    try {
      await f.click('a', { ctrlKey: true });
      f.list.mockResolvedValue({
        ...page(),
        items: [{ ...page().items[0]!, id: 'e', subject: '邮件 e' }],
      });
      await f.setActive(false);
      await f.setActive(true);
      expect(f.checked()).toEqual([]);
      await f.click('e', { shiftKey: true });
      expect(f.checked()).toEqual(['e']);
    } finally {
      f.close();
    }
  });

  it('列表键盘全选与取消沿用公共逻辑，不拦截搜索输入框', async () => {
    const f = await selectionView();
    try {
      await f.click('b', { ctrlKey: true });
      await act(async () =>
        f.host.querySelector('[data-weq-select-id="b"]')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(f.checked()).toEqual(['a', 'b', 'c', 'd', 'e']);
      act(() => {
        const button = f.host.querySelector<HTMLButtonElement>('[data-weq-select-id="b"]')!;
        button.focus();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(f.checked()).toEqual([]);
      const search = f.host.querySelector<HTMLInputElement>('[aria-label="搜索邮件"]')!;
      act(() => {
        search.focus();
        search.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }),
        );
      });
      expect(f.checked()).toEqual([]);
      expect(f.api.read).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('带修饰键点击星标仍只处理该邮件，不混入多选或读信', async () => {
    const f = await selectionView();
    try {
      await f.click('a', { ctrlKey: true });
      await act(async () =>
        f.host
          .querySelector('[aria-label="设为星标 邮件 c"]')!
          .dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true })),
      );
      expect(f.api.action).toHaveBeenCalledWith(['c'], 'star');
      expect(f.checked()).toEqual(['a']);
      expect(f.api.read).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});

describe('附件公共保存入口', () => {
  it('按所选附件的真实文件名准备单文件，创建任务而非直接另存', async () => {
    const view = await attachmentView();
    try {
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[aria-label="保存附件 README"]')!.click(),
      );
      expect(saveState.prepare).toHaveBeenCalledWith(undefined, {
        kind: 'file',
        name: 'README',
        fileName: 'README',
      });
      expect(view.api.save).toHaveBeenCalledWith('attachment-token', { mode: 'after' }, 'source-a');
      expect(view.api.download).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain('README');
    } finally {
      view.close();
    }
  });
  it('本次另存取消不发起下载，保留邮件正文和附件列表', async () => {
    const view = await attachmentView();
    saveState.prepare.mockResolvedValueOnce(null);
    try {
      act(() =>
        view.host
          .querySelector<HTMLButtonElement>('[aria-label="附件 README 的本次保存选项"]')!
          .click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === '另存到…')!
          .click(),
      );
      expect(saveState.prepare.mock.calls[0]![0]).toEqual({ mode: 'before' });
      expect(view.api.save).not.toHaveBeenCalled();
      expect(view.api.download).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain('README');
    } finally {
      view.close();
    }
  });
  it('准备期间来源变化，不将旧附件写入新来源', async () => {
    const view = await attachmentView();
    saveState.prepare.mockImplementationOnce(async () => {
      saveState.current = false;
      return { mode: 'after' };
    });
    try {
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[aria-label="保存附件 README"]')!.click(),
      );
      expect(view.api.save).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
  it('Web 浏览器下载与服务器保存分开，不准备服务器路径', async () => {
    saveState.web = true;
    const view = await attachmentView();
    try {
      expect(view.host.querySelector('[title="保存附件到服务器"]')).not.toBeNull();
      await act(async () =>
        view.host
          .querySelector<HTMLButtonElement>('[aria-label="下载附件 README 到浏览器"]')!
          .click(),
      );
      expect(view.api.download).toHaveBeenCalledWith('attachment-token', expect.any(AbortSignal));
      expect(saveState.prepare).not.toHaveBeenCalled();
      expect(view.api.save).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
});
