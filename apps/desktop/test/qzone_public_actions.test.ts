import { act, createElement as h, Fragment, type ContextType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';
import { onNotificationNavigation } from '../src/renderer/src/lib/notificationNavigation.shared';
import { QzonePublicPane } from '../src/renderer/src/views/QzonePublicView';
import {
  QzoneProfileContext,
  QzoneShareForwardContext,
} from '../src/renderer/src/lib/qzoneNavigation';

const shareArk = '{"app":"com.tencent.structmsg","meta":{"news":{"title":"空间分享"}}}';

const state = vi.hoisted(() => ({
  like: vi.fn(async () => ({})),
  reply: vi.fn(async () => ({
    reply: { id: 'new', user: { uid: 'self' }, content: [{ type: 0, content: '新回复' }] },
  })),
  forward: vi.fn(async () => ({})),
  share: vi.fn(async (_input: unknown) => ({
    ark: shareArk,
    requires_confirmation: false,
    notice: null,
  })),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    available: true,
    busy: false,
  }),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { getSettings: { query: async () => ({ qzoneForwardQuotePrevious: true }) } },
    account: {
      qqActions: { qzoneFeedShare: { mutate: state.share } },
      qzone: { cancel: { mutate: async () => {} } },
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
                cell_operation: {
                  share_outside: {
                    share_access_resource: { busi_id: 'zone', resource_id: 'post-a' },
                  },
                },
                cell_feed_transfer: 'opaque-feed-transfer',
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
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  const navigate = vi.fn();
  const unsubscribe = onNotificationNavigation(navigate);
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  bindAccountState(binding);
  close = () => {
    unsubscribe();
    focus.mockRestore();
    act(() => root.unmount());
    bindAccountState(null);
    host.remove();
  };
  const profile = vi.fn();
  const space = vi.fn();
  const friend = {
    id: 'friend',
    kind: 'c2c' as const,
    conv: '10003',
    name: '合成好友',
    avatarUrl: null,
  };
  const group = {
    id: 'group',
    kind: 'group' as const,
    conv: '10004',
    name: '合成群',
    avatarUrl: null,
  };
  const send = vi
    .fn<NonNullable<ContextType<typeof QzoneShareForwardContext>>['send']>()
    .mockResolvedValue(undefined);
  send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('测试发送失败'));
  await act(async () =>
    root.render(
      h(
        Fragment,
        null,
        h(
          QzoneProfileContext.Provider,
          { value: profile },
          h(
            QzoneShareForwardContext.Provider,
            { value: { targets: [friend, group], send } },
            h(QzonePublicPane, { selfUin: '10001', onSpace: space }),
          ),
        ),
        h(ToastHost),
      ),
    ),
  );
  const avatar = host.querySelector<HTMLButtonElement>(
    '.weq-qzn-person-header > .weq-qzn-profile-avatar',
  )!;
  act(() => avatar.click());
  expect(space).toHaveBeenCalledWith('10002', '原作者');
  expect(profile).not.toHaveBeenCalled();
  expect(state.share).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(state.share).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    feed: expect.objectContaining({ cell_feed_transfer: 'opaque-feed-transfer' }),
  });
  const dialog = document.querySelector('[role="dialog"]')!;
  const button = (label: string) =>
    [...dialog.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  expect(send).not.toHaveBeenCalled();
  expect(button('转发到会话').disabled).toBe(true);
  await act(async () => {
    button('合成好友10003').click();
    button('合成群').click();
  });
  expect(send).not.toHaveBeenCalled();
  await act(async () => button('转发到会话').click());
  expect(send.mock.calls).toEqual([
    [shareArk, friend, binding],
    [shareArk, group, binding],
  ]);
  expect(dialog.textContent).toContain('测试发送失败');
  await act(async () => button('转发到会话').click());
  expect(send.mock.calls.slice(2)).toEqual([[shareArk, group, binding]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const receipt = host
    .querySelector<HTMLButtonElement>('[aria-label="选择转发会话"]')
    ?.closest<HTMLElement>('[role="status"]');
  expect(receipt).toBeTruthy();
  await act(async () => receipt!.click());
  expect(navigate.mock.calls).toEqual([
    [{ kind: 'forwarded-conversations', targets: [friend, group], binding }],
  ]);
  space.mockClear();
  act(() => host.querySelector<HTMLButtonElement>('.weq-qzn-person-info > button')!.click());
  expect(space).toHaveBeenCalledWith('10002', '原作者');
  expect(profile).not.toHaveBeenCalled();
  const actions = host.querySelector('.weq-qzn-actions')!;
  const forward = actions.querySelector<HTMLButtonElement>('[aria-label="转发"]')!;
  await act(async () => forward.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(document.querySelector('[aria-label="转发列表"]')?.textContent).toContain(
    '暂无法查看转发名单',
  );
  expect(state.forward).not.toHaveBeenCalled();
  const liked = actions.querySelector<HTMLButtonElement>('[aria-label="取消点赞"]')!;
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
  await act(async () => buttons[0]!.click());
  expect(
    host.querySelector('[aria-label="回复内容"]')?.closest('.weq-qzn-comment')?.textContent,
  ).toContain('评论原文');
  expect(host.querySelector('[aria-label="回复内容"]')?.closest('.is-reply')).toBeNull();
  await act(async () => buttons[1]!.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="回复内容"]')!;
  expect(input.closest('.is-reply')?.textContent).toContain('回复原文');
  expect(host.querySelectorAll('.weq-qzn-public-composer')).toHaveLength(1);
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
