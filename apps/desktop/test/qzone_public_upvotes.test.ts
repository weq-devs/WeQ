import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzonePublicPane } from '../src/renderer/src/views/QzonePublicView';

const state = vi.hoisted(() => ({
  upvote: vi.fn(async (_input: unknown) => ({ upvote: {} })),
  canUpvote: true,
  cell: {
    num: 199,
    upvoted: false,
    upvote_mans: [{ user: { uin: '10002', uid: 'other', nick: '合成推用户' } }],
  } as Record<string, unknown> | null,
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { getSettings: { query: async () => ({}) } },
    account: {
      qzone: { cancel: { mutate: async () => {} } },
      qzonePublic: {
        me: {
          query: async () => ({ uin: '10001', uid: 'self', nick: '合成自己', publicUid: 'self' }),
        },
        capabilities: {
          query: async () => ({ public_qzone_entrance_switch: true, can_upvote: state.canUpvote }),
        },
        feeds: {
          query: async () => ({
            feeds: [
              {
                cell_common: { union_id: { uf_key: 'fixture' }, time: '1' },
                cell_user_info: { user: { uid: 'author', uin: '10003', nick: '合成作者' } },
                cell_summary: { summary: [{ type: 0, content: '合成说说' }] },
                cell_upvote: state.cell,
              },
            ],
            has_more: false,
          }),
        },
        upvote: { mutate: state.upvote },
        cancel: { mutate: async () => {} },
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
it('公共空间推人数和预览联动，取消正确发送，失败恢复人数和用户', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () => root.render(h(QzonePublicPane, { selfUin: '10001' })));
  const button = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="推"], [aria-label="取消推"]')!;
  expect(button().textContent).toBe('推 199');
  await act(async () => button().focus());
  const panel = () => document.querySelector<HTMLElement>('[aria-label="推的人"]')!;
  expect(panel().textContent).toContain('合成推用户');
  expect(state.upvote).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(state.upvote).toHaveBeenLastCalledWith(expect.objectContaining({ enable: true }));
  expect(button().textContent).toBe('推 200');
  expect(button().getAttribute('aria-label')).toBe('取消推');
  expect(panel().textContent).toContain('合成自己');
  state.upvote.mockRejectedValueOnce(new Error('合成推失败'));
  await act(async () => button().click());
  expect(state.upvote).toHaveBeenLastCalledWith(expect.objectContaining({ enable: false }));
  expect(button().textContent).toBe('推 200');
  expect(button().getAttribute('aria-label')).toBe('取消推');
  expect(panel().textContent).toContain('合成自己');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成推失败');
  await act(async () => button().click());
  expect(button().textContent).toBe('推 199');
  expect(panel().textContent).not.toContain('合成自己');
  expect(panel().textContent).toContain('合成推用户');
});
