import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzonePublicPane } from '../src/renderer/src/views/QzonePublicView';
import { QzoneProfileContext } from '../src/renderer/src/lib/qzoneNavigation';

const state = vi.hoisted(() => ({
  like: vi.fn(async () => ({})),
  reply: vi.fn(async () => ({
    reply: { id: 'new', user: { uid: 'self' }, content: [{ type: 0, content: '新回复' }] },
  })),
  forward: vi.fn(async () => ({})),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { getSettings: { query: async () => ({ qzoneForwardQuotePrevious: true }) } },
    account: {
      qzonePublic: {
        me: { query: async () => ({ uin: '10001', uid: 'self', nick: '自己', publicUid: 'self' }) },
        capabilities: {
          query: async () => ({ public_qzone_entrance_switch: true, can_upvote: false }),
        },
        feeds: {
          query: async () => ({
            feeds: [
              {
                cell_common: { union_id: { uf_key: 'post-a' }, time: '1' },
                cell_user_info: { user: { uid: 'author', uin: '10002', nick: '原作者' } },
                cell_summary: { summary: [{ type: 0, content: '上一人文案' }] },
                cell_like: { num: 7, liked: true },
                cell_comment: { num: 1 },
                cell_foward_info: { retweet_count: 2 },
                cell_visitor: { view_num: 9 },
              },
            ],
            has_more: false,
          }),
        },
        detail: {
          query: async () => ({
            feed: {
              feed: {
                cell_comment: {
                  comments: [
                    {
                      id: '1',
                      time: '1',
                      user: { uid: 'commenter', nick: '评论者' },
                      content: [{ type: 0, content: '评论原文' }],
                      reply_num: 1,
                      replys: [
                        {
                          id: '2',
                          time: '2',
                          user: { uid: 'replier', nick: '回复者' },
                          content: [{ type: 0, content: '回复原文' }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            has_more: false,
          }),
        },
        cancel: { mutate: async () => {} },
        like: { mutate: state.like },
        reply: { mutate: state.reply },
        forward: { mutate: state.forward },
      },
    },
  },
}));

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('公共空间统一操作顺序，保留初始已赞状态，回复和转发接入真实路由', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  const profile = vi.fn();
  const space = vi.fn();
  await act(async () =>
    root.render(
      h(
        QzoneProfileContext.Provider,
        { value: profile },
        h(QzonePublicPane, { selfUin: '10001', onSpace: space }),
      ),
    ),
  );
  const avatar = host.querySelector<HTMLButtonElement>('.weq-qzn-profile-avatar')!;
  act(() => avatar.click());
  expect(space).toHaveBeenCalledWith('10002', '原作者');
  expect(profile).not.toHaveBeenCalled();
  space.mockClear();
  act(() => host.querySelector<HTMLButtonElement>('.weq-qzn-public-name')!.click());
  expect(space).toHaveBeenCalledWith('10002', '原作者');
  expect(profile).not.toHaveBeenCalled();
  const actions = host.querySelector('.weq-qzn-actions')!;
  expect(actions.textContent).toBe('点赞 7评论 1转发 2推 ?浏览量 9');
  const liked = actions.querySelector<HTMLButtonElement>('[aria-label="取消赞"]')!;
  expect(liked.getAttribute('aria-pressed')).toBe('true');
  await act(async () => liked.click());
  expect(state.like).toHaveBeenCalledWith(expect.objectContaining({ enable: false }));
  await act(async () =>
    actions.querySelector<HTMLButtonElement>('[aria-label="查看评论"]')!.click(),
  );
  const buttons = [
    ...host.querySelectorAll<HTMLButtonElement>('.weq-qzn-comment-meta button'),
  ].filter((button) => button.textContent === '回复');
  expect(buttons).toHaveLength(2);
  await act(async () => buttons[1]!.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="回复内容"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '新回复',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('.weq-qzn-public-composer button.weq-qzn-primary')!
      .click(),
  );
  expect(state.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      comment: expect.objectContaining({ id: '1' }),
      reply: expect.objectContaining({ id: '2' }),
      content: '新回复',
    }),
  );
  await act(async () => actions.querySelector<HTMLButtonElement>('[aria-label="转发"]')!.click());
  const reason = document.querySelector<HTMLTextAreaElement>('[aria-label="转发语"]')!;
  expect(reason.value).toBe('//：上一人文案');
  expect(reason.selectionStart).toBe(0);
  expect(document.querySelector('[aria-label="原动态"]')!.textContent).toContain('上一人文案');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.weq-qzn-forward-dialog footer button')!.click(),
  );
  expect(state.forward).toHaveBeenCalledWith(expect.objectContaining({ reason: '//：上一人文案' }));
});
