import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HistoricalSignature } from '@weq/protocol';
import { SignatureInteractions } from '../src/renderer/src/components/ProfileInteractions';

const rpc = vi.hoisted(() => ({
  send: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqActions: {
        signatureComment: { mutate: rpc.send },
        deleteSignatureComment: { mutate: rpc.remove },
      },
    },
  },
  trpc: {
    account: { profileExtras: { signatureLikes: { useInfiniteQuery: () => ({}) } } },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => rpc.confirm,
}));
vi.mock('../src/renderer/src/components/QzoneLikesPopover', () => ({
  QzoneLikesPopover: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock('../src/renderer/src/components/ProfileAvatar', () => ({
  ProfileAvatar: ({ children }: { children: ReactNode }) => h('span', null, children),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: () => null,
}));
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'fixture',
  uin: '10002',
};
const comment = {
  id: 'comment-1',
  text: '合成评论',
  fromUin: '10003',
  fromName: '合成好友',
  toUin: null,
  toName: null,
  replyId: null,
  time: 1700000000,
};
const item: HistoricalSignature = {
  id: 'signature-1',
  text: '合成签名',
  action: null,
  data: null,
  location: null,
  createdAt: 1700000000,
  commentItems: [comment, { ...comment, id: 'comment-2', fromName: '第二位好友' }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(online = true, signature = item) {
  await act(async () => {
    root.render(h(SignatureInteractions, { input, item: signature, online, refresh: rpc.refresh }));
  });
}
function button(label: string) {
  const found = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function editor() {
  return host.querySelector<HTMLTextAreaElement>('[aria-label="签名评论"]')!;
}
async function fill(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      editor(),
      text,
    );
    editor().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  rpc.send.mockResolvedValue({ commentId: 'new-comment' });
  rpc.confirm.mockResolvedValue(true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('仅保留评论入口，展开即显示聚焦的内联输入框，收起再打开保留草稿', async () => {
  await render();
  expect(host.querySelector('[aria-label="写签名评论"]')).toBeNull();
  expect(editor()).toBeNull();
  await click('评论');
  expect(button('评论').getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('textarea')).toHaveLength(1);
  expect(editor()).toBe(document.activeElement);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(button('发送评论').disabled).toBe(true);
  await fill('保留草稿');
  await click('评论');
  expect(editor()).toBeNull();
  await click('评论');
  expect(editor().value).toBe('保留草稿');
});

it('回复框跟随目标评论移动，取消回复回到顶部，共用同一份草稿', async () => {
  await render();
  await click('评论');
  await fill('共同草稿');
  await click('回复评论');
  expect(editor().closest('li')?.textContent).toContain('合成好友');
  expect(editor()).toBe(document.activeElement);
  expect(editor().placeholder).toBe('回复 合成好友');
  expect(editor().value).toBe('共同草稿');
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>('[aria-label="回复评论"]')[1]!.click(),
  );
  expect(editor().closest('li')?.textContent).toContain('第二位好友');
  expect(host.querySelectorAll('textarea')).toHaveLength(1);
  await click('取消回复');
  expect(editor().closest('li')).toBeNull();
  expect(editor().placeholder).toBe('写评论');
  expect(editor().value).toBe('共同草稿');
  expect(editor()).toBe(document.activeElement);
});

it('发送普通评论后保持展开，显示新增评论并清空正文', async () => {
  await render();
  await click('评论');
  await fill(' 新的评论 ');
  await click('发送评论');
  expect(rpc.send).toHaveBeenCalledOnce();
  expect(rpc.send).toHaveBeenCalledWith({
    ...input,
    id: item.id,
    text: '新的评论',
    replyId: undefined,
  });
  expect(host.querySelector('.weq-signature-comments')?.textContent).toContain('新的评论');
  expect(editor().value).toBe('');
  expect(button('评论').getAttribute('aria-expanded')).toBe('true');
  expect(rpc.refresh).toHaveBeenCalledOnce();
});

it('发送失败保留回复目标和正文，重试成功后回到普通评论输入', async () => {
  rpc.send.mockRejectedValueOnce(new Error('合成发送失败'));
  await render();
  await click('评论');
  await click('回复评论');
  await fill('回复正文');
  await click('发送评论');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('合成发送失败');
  expect(editor().value).toBe('回复正文');
  expect(editor().closest('li')?.textContent).toContain('合成好友');
  await click('发送评论');
  expect(rpc.send).toHaveBeenLastCalledWith({
    ...input,
    id: item.id,
    text: '回复正文',
    replyId: comment.id,
  });
  expect(editor().closest('li')).toBeNull();
  expect(editor().value).toBe('');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('.weq-signature-comments')?.textContent).toContain('回复正文');
});

it('提交中禁用发送和目标切换，重复提交只发送一次，收起不丢失结果', async () => {
  let finish!: (value: { commentId: string }) => void;
  rpc.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await render();
  await click('评论');
  await fill('在途正文');
  await click('发送评论');
  expect(editor().disabled).toBe(true);
  expect(button('回复评论').disabled).toBe(true);
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  });
  expect(rpc.send).toHaveBeenCalledOnce();
  await click('评论');
  await act(async () => finish({ commentId: 'inflight-comment' }));
  expect(editor()).toBeNull();
  await click('评论');
  expect(editor().value).toBe('');
  expect(host.querySelector('.weq-signature-comments')?.textContent).toContain('在途正文');
});

it('删除正在回复的本人评论后回到普通输入，保留未发送正文', async () => {
  await render(true, {
    ...item,
    commentItems: [{ ...comment, fromUin: input.expectedAccountUin }],
  });
  await click('评论');
  await click('回复评论');
  await fill('未发送正文');
  await click('删除评论：合成评论');
  expect(rpc.remove).toHaveBeenCalledWith({
    ...input,
    id: item.id,
    createdAt: item.createdAt,
    commentId: comment.id,
  });
  expect(host.querySelector('.weq-signature-comments li')).toBeNull();
  expect(editor().closest('li')).toBeNull();
  expect(editor().value).toBe('未发送正文');
});

it('刷新后回复目标消失时回到普通输入，不隐藏草稿或继续引用旧评论', async () => {
  await render();
  await click('评论');
  await click('回复评论');
  await fill('刷新前的草稿');
  await render(true, { ...item, commentItems: [] });
  expect(editor()).not.toBeNull();
  expect(editor().closest('li')).toBeNull();
  expect(editor().value).toBe('刷新前的草稿');
  await click('发送评论');
  expect(rpc.send).toHaveBeenCalledWith({
    ...input,
    id: item.id,
    text: '刷新前的草稿',
    replyId: undefined,
  });
});

it('无评论可直接写入；离线仍可展开现有评论，但不出现发送和回复入口', async () => {
  await render(true, { ...item, commentItems: [] });
  await click('评论');
  expect(host.textContent).toContain('暂无评论');
  expect(editor()).not.toBeNull();
  await render(false);
  expect(host.querySelectorAll('.weq-signature-comments li')).toHaveLength(2);
  expect(editor()).toBeNull();
  expect(host.querySelector('[aria-label="回复评论"]')).toBeNull();
  expect(host.querySelector('[aria-label="发送评论"]')).toBeNull();
});
