import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportantMessagesList } from '../src/renderer/src/components/ImportantMessages';
const rpc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { listImportantGroupMessages: { query: rpc.query } } },
}));
const row = (msgSeq: string) => ({
  msgSeq,
  msgId: `900${msgSeq}`,
  sendTime: '1794380000',
  senderUid: 'u_peer',
  unread: false,
  preview: `正文 ${msgSeq}`,
  reasons: [
    { kind: 'atMe', rawKind: 1000, text: '' },
    { kind: 'replyMe', rawKind: 1002, text: '' },
  ],
});
const page = (seqs: string[], nextBefore: string | null = null) => ({
  items: seqs.map(row),
  nextBefore,
  contentUnavailable: false,
});
const props = {
  groupCode: '777',
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  senderName: () => '本地群名片',
  onLocate: vi.fn(),
  onClose: vi.fn(),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(h(ImportantMessagesList, props)));
const hit = () => host.querySelector<HTMLButtonElement>('.weq-important-row')!;

it('已读条目显示多个命中原因；连续定位同一条仍生效，失败后保留条目重试', async () => {
  rpc.query.mockResolvedValue(page(['102', '101']));
  await render();
  expect(host.textContent).toContain('本地群名片');
  expect(host.textContent).toContain('有人@我 · 有人回复我');
  await act(async () => hit().click());
  await act(async () => hit().click());
  expect(props.onLocate).toHaveBeenCalledTimes(2);
  expect(props.onLocate).toHaveBeenLastCalledWith({ seq: '102', msgId: '900102' });
  props.onLocate.mockRejectedValueOnce(new Error('合成定位失败'));
  await act(async () => hit().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成定位失败');
  expect(host.querySelectorAll('li')).toHaveLength(2);
  await act(async () => hit().click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
});
it('定位进行中防止重复请求，结束后可以再定位', async () => {
  rpc.query.mockResolvedValue(page(['102']));
  let release!: () => void;
  props.onLocate.mockReturnValueOnce(
    new Promise<void>((done) => {
      release = done;
    }),
  );
  await render();
  await act(async () => hit().click());
  expect(hit().disabled).toBe(true);
  await act(async () => hit().click());
  expect(props.onLocate).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(hit().disabled).toBe(false);
});
it('八类多选与全选清空沿用搜索选择方式，分页重置游标，失败可重试', async () => {
  rpc.query.mockResolvedValueOnce(page(['102'], '102'));
  await render();
  rpc.query.mockResolvedValueOnce(page(['101']));
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '加载更多')!
      .click(),
  );
  expect(rpc.query.mock.calls.at(-1)?.[0].before).toBe('102');
  expect(host.querySelectorAll('li')).toHaveLength(2);
  expect(host.textContent).not.toContain('仅未读');
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('[aria-label="刷新重要消息"]')).toBeNull();
  expect(host.querySelectorAll('[data-weq-select-id]')).toHaveLength(8);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="全部类型"]')!.click());
  expect(host.textContent).toContain('未选择消息类型');
  rpc.query.mockRejectedValueOnce(new Error('合成查询失败'));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-weq-select-id="replyMe"]')!.click();
  });
  expect(rpc.query.mock.calls.at(-1)?.[0]).toMatchObject({ kinds: ['replyMe'], before: undefined });
  expect(host.textContent).toContain('合成查询失败');
  rpc.query.mockResolvedValueOnce(page([]));
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '重试')!.click(),
  );
  expect(host.textContent).toContain('暂无已记录的重要消息');
  rpc.query.mockResolvedValueOnce(page([]));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-weq-select-id="atMe"]')!.click(),
  );
  expect(rpc.query.mock.calls.at(-1)?.[0].kinds).toEqual(
    expect.arrayContaining(['replyMe', 'atMe']),
  );
  expect(rpc.query.mock.calls.at(-1)?.[0].unreadOnly).toBeUndefined();
});

it('定位后保留列表并选中原条目，右键与单击共用精确定位', async () => {
  rpc.query.mockResolvedValue(page(['102', '101']));
  await render();
  await act(async () => hit().click());
  expect(hit().getAttribute('aria-current')).toBe('true');
  act(() =>
    hit().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 })),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(props.onLocate).toHaveBeenLastCalledWith({ seq: '102', msgId: '900102' });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(host.querySelectorAll('li')).toHaveLength(2);
});
it('切换来源后丢弃迟到结果', async () => {
  let release!: (value: unknown) => void;
  rpc.query.mockReturnValueOnce(
    new Promise((done) => {
      release = done;
    }),
  );
  await render();
  rpc.query.mockResolvedValueOnce(page([]));
  await act(async () =>
    root.render(
      h(ImportantMessagesList, {
        ...props,
        binding: { ...props.binding, expectedAccountConfigId: 'source-b' },
      }),
    ),
  );
  await act(async () => release(page(['102'])));
  expect(host.querySelectorAll('li')).toHaveLength(0);
});

it('关闭时不轮询；重新打开自动补新摘要，不丢已加载旧页或重复已有行', async () => {
  rpc.query.mockResolvedValueOnce(page(['102', '101'], '101'));
  await render();
  await act(async () => root.render(h(ImportantMessagesList, { ...props, open: false })));
  expect(rpc.query).toHaveBeenCalledOnce();
  rpc.query.mockResolvedValueOnce(page(['103', '102'], '102'));
  await act(async () => root.render(h(ImportantMessagesList, { ...props, open: true })));
  expect(
    [...host.querySelectorAll<HTMLElement>('[data-important-seq]')].map(
      (row) => row.dataset.importantSeq,
    ),
  ).toEqual(['103', '102', '101']);
  expect(rpc.query.mock.calls.at(-1)?.[0].before).toBeUndefined();
  rpc.query.mockResolvedValueOnce(page(['100']));
  await act(async () =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === '加载更多')!.click(),
  );
  expect(rpc.query.mock.calls.at(-1)?.[0].before).toBe('101');
});
