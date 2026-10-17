// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailPage as MailPageData, MailStatus } from '@weq/service/mail';
import { SYSTEM_MAIL_FOLDERS } from '@weq/service/mail-wire';
import { MailPage } from '../src/renderer/src/views/mail/MailPage';
import type { MailApi } from '../src/renderer/src/views/mail/api';

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
    image: vi.fn(async () => ({ mime: 'image/png', base64: '' })),
    subscribe: vi.fn(() => () => {}),
    openLink: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { api, list };
}
afterEach(() => vi.unstubAllGlobals());
async function mount(api: MailApi) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MailPage, { api, selfEmail: 'self@example.invalid' })),
  );
  return {
    host,
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
