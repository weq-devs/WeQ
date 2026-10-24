// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailExportPane } from '../src/renderer/src/views/export/MailExportPane';
import type { ContentSelection } from '../src/shared/content_selection';
import type { MailSummary } from '@weq/service/mail';

const state = vi.hoisted(() => ({
  current: true,
  mutate: vi.fn(async (_input: unknown) => 'mail-task'),
  preview: vi.fn<(input: unknown) => Promise<MailSummary[]>>(),
  cancel: vi.fn(async (_input: unknown) => null),
  prepare: vi.fn(async (..._args: unknown[]) => ({ mode: 'after' as const })),
  started: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }) },
    },
  },
  client: {
    mail: {
      exportMessages: { mutate: state.mutate },
      previewExport: { mutate: state.preview },
      cancel: { mutate: state.cancel },
    },
  },
}));
const summary: MailSummary = {
  id: 'preview-one',
  subject: '合成主题',
  sender: { name: '夹具发件人', email: 'sender@example.invalid' },
  folderId: 1,
  messageId: '',
  snippet: '',
  to: [],
  cc: [],
  bcc: [],
  time: 1,
  size: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
  draft: false,
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.current = true;
  state.mutate.mockClear();
  state.prepare.mockClear();
  state.started.mockClear();
  state.preview.mockReset().mockResolvedValue([summary]);
  state.cancel.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
async function mount(selection?: ContentSelection) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MailExportPane, {
        initialSelection: selection,
        prepareSave: state.prepare,
        isCurrent: () => state.current,
        onStarted: state.started,
      }),
    ),
  );
  return {
    host,
    query: () =>
      act(async () =>
        host.querySelector<HTMLButtonElement>('.weq-mail-export-preview button')!.click(),
      ),
    submit: () =>
      act(async () => host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click()),
    input: async (index: number, value: string) => {
      const input = host.querySelectorAll<HTMLInputElement>('.weq-mail-export-filters input')[
        index
      ]!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    },
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
it('先按北京时间和文本条件查询列表数量，确认后只导出预览中的邮件', async () => {
  const f = await mount();
  try {
    await f.input(0, '2026-10-01');
    await f.input(1, '2026-10-24');
    await f.input(2, ' sender@example.invalid ');
    await f.input(3, '合成主题');
    await f.submit();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    await f.query();
    expect(state.preview).toHaveBeenCalledWith({
      selfUin: '10001',
      expectedAccountConfigId: 'source-a',
      requestId: expect.any(String),
      ids: null,
      filter: {
        startTime: Date.parse('2026-09-30T16:00:00Z') / 1000,
        endTime: Date.parse('2026-10-24T16:00:00Z') / 1000,
        sender: 'sender@example.invalid',
        subject: '合成主题',
      },
    });
    expect(f.host.textContent).toContain('待导出 1 封邮件');
    expect(f.host.querySelector('[aria-label="待导出邮件列表"]')?.textContent).toContain(
      summary.subject,
    );
    expect(f.host.textContent).toContain(summary.sender.name);
    await f.submit();
    expect(state.mutate).toHaveBeenCalledWith({
      selfUin: '10001',
      expectedAccountConfigId: 'source-a',
      ids: ['preview-one'],
      expandThreads: false,
      savePolicy: { mode: 'after' },
    });
    expect(state.started).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});
it('所选邮件可切到所有邮件，错误日期不入队，切源后不提交旧任务', async () => {
  const f = await mount({
    owner: { kind: 'mail-messages', container: 'fixture' },
    scope: { type: 'items', ids: ['one', 'one'] },
  });
  try {
    await f.query();
    expect(state.preview).toHaveBeenLastCalledWith(expect.objectContaining({ ids: ['one'] }));
    await f.submit();
    await act(async () => f.host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await f.submit();
    expect(state.mutate).toHaveBeenCalledTimes(1);
    await f.query();
    expect(state.preview).toHaveBeenLastCalledWith(expect.objectContaining({ ids: null }));
    await f.submit();
    await f.input(0, '2026-10-24');
    await f.input(1, '2026-10-01');
    await f.submit();
    expect(state.mutate).toHaveBeenCalledTimes(2);
    await f.input(1, '2026-10-24');
    await f.query();
    state.current = false;
    await f.submit();
    expect(state.mutate).toHaveBeenCalledTimes(2);
  } finally {
    f.close();
  }
});

it('修改条件取消在途查询并丢弃迟到结果，空结果或失败不开放导出', async () => {
  const f = await mount();
  try {
    let resolve!: (rows: MailSummary[]) => void;
    state.preview.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await f.query();
    await f.input(2, '另一个发件人');
    expect(state.cancel).toHaveBeenCalledTimes(1);
    await act(async () => resolve([summary]));
    await f.submit();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(f.host.textContent).not.toContain('待导出 1 封邮件');
    state.preview.mockResolvedValueOnce([]);
    await f.query();
    expect(f.host.textContent).toContain('待导出 0 封邮件');
    await f.submit();
    expect(state.mutate).not.toHaveBeenCalled();
    state.preview.mockRejectedValueOnce(new Error('合成读取失败'));
    await f.query();
    expect(f.host.textContent).toContain('合成读取失败');
    await f.submit();
    expect(state.mutate).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
